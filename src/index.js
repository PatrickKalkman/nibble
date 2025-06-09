import 'dotenv/config';
import fastify from 'fastify';
import { Webhooks } from '@octokit/webhooks';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import cron from 'node-cron';
import { readFileSync } from 'fs';
import pino from 'pino';
import crypto from 'crypto';
import NibbleService from './services/nibbleService.js';
import { 
  createAuthMiddleware, 
  verifyWebhookSignature 
} from './services/middleware/auth.js';
import {
  securityHeaders,
  blockSuspiciousRequests,
  createAdvancedRateLimiter,
  securityLogger,
  createGeoBlock
} from './services/middleware/security.js';

const logger = pino();

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

const appId      = process.env.GITHUB_APP_ID;
const privateKey = readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');

const API_SECRET = process.env.NIBBLE_API_SECRET || crypto.randomBytes(32).toString('hex');
const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS === 'true';

if (process.env.NODE_ENV !== 'production') {
  logger.info(`API Secret: ${API_SECRET}`);
} else {
  logger.info('API authentication enabled');
}

const requireAuth = createAuthMiddleware(API_SECRET);
const webhookAuth = verifyWebhookSignature(process.env.GITHUB_WEBHOOK_SECRET);
const advancedRateLimiter = createAdvancedRateLimiter({
  maxRequests: 20,      // 20 requests per minute
  windowMs: 60000,      // 1 minute window
  blockDuration: 600000, // 10 minute block
  maxViolations: 3      // Block after 3 violations
});
const geoBlock = createGeoBlock();

const appAuth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8'),
});

const appAdapter = {
  // ── JWT-scoped Octokit ─────────────────────────────────────────────
  async auth(installationId = null) {
    if (installationId) {
      return new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId }
      });
    } else {
      return new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey }
      });
    }
  },

  // ── Installation-scoped Octokit ────────────────────────────────────
  async getInstallationOctokit(installationId) {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId }
    });
  }
};

// Initialize webhooks
const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET,
});

// Initialize our Nibble service
const nibbleService = new NibbleService(appAdapter);

// Start the Fastify server
const app = fastify({ logger: true });

// Register global security middleware (order matters!)
app.addHook('onRequest', securityLogger());
app.addHook('onRequest', securityHeaders());
app.addHook('onRequest', blockSuspiciousRequests());
app.addHook('onRequest', advancedRateLimiter);
app.addHook('onRequest', geoBlock);

app.setNotFoundHandler((request, reply) => {
  logger.warn({
    ip: request.ip,
    method: request.method,
    url: request.url,
    userAgent: request.headers['user-agent'],
    type: 'not_found'
  }, '404 request');
  
  reply.code(404).send({ error: 'Not found' });
});

// Custom error handler
app.setErrorHandler((error, request, reply) => {
  logger.error({
    ip: request.ip,
    method: request.method,
    url: request.url,
    error: error.message,
    stack: error.stack,
    type: 'server_error'
  }, 'Server error');

  // Don't expose internal error details in production
  if (process.env.NODE_ENV === 'production') {
    reply.code(500).send({ error: 'Internal server error' });
  } else {
    reply.code(500).send({ error: error.message });
  }
});

// Webhook handlers
webhooks.on('installation.created', async ({ payload }) => {
  logger.info(`Nibble installed on ${payload.installation.account.login}`);
  await nibbleService.handleInstallation(payload.installation);
});

webhooks.on('push', async ({ payload }) => {
  // Only process pushes to main/master branch
  if (payload.ref === 'refs/heads/main' || payload.ref === 'refs/heads/master') {
    logger.info(`Push detected to ${payload.repository.full_name}`);
    // Trigger a nibble analysis (could be async)
    await nibbleService.scheduleDailyNibble(payload.repository, payload.installation);
  }
});

app.post('/deploy', 
  { preHandler: [webhookAuth] },
  async (request, reply) => {
    try {
      const { ref, repository } = request.body;
      
      // Only deploy on main branch pushes to YOUR nibble repo
      if (repository?.full_name !== 'PatrickKalkman/nibble' || 
          ref !== 'refs/heads/master') {
        return { status: 'ignored', reason: 'not master branch or not nibble repo' };
      }
      
      logger.info('Deploying new version...');
      
      // Execute deployment script
      const { exec } = await import('child_process');
      const util = await import('util');
      const execPromise = util.promisify(exec);
      
      try {
        // Run your deployment script
        const { stdout, stderr } = await execPromise('/home/ubuntu/nibble/deploy.sh');
        logger.info('Deploy output:', stdout);
        if (stderr) logger.error('Deploy errors:', stderr);
        
        return { 
          status: 'success', 
          message: 'Deployment initiated',
          output: stdout.slice(-500) // Last 500 chars
        };
      } catch (error) {
        logger.error('Deployment failed:', error);
        return reply.code(500).send({ 
          status: 'failed', 
          error: error.message 
        });
      }
      
    } catch (error) {
      logger.error('Deploy endpoint error:', error);
      return reply.code(500).send({ error: error.message });
    }
  }
);

// Health check endpoint
app.get('/', async (request, reply) => {
  return { 
    status: 'OK',
    service: 'Nibble',
    timestamp: new Date().toISOString()
  };
});

// Block common bot requests explicitly
app.get('/robots.txt', async (request, reply) => {
  reply.type('text/plain');
  return `User-agent: *
Disallow: /
Crawl-delay: 86400`;
});

app.get('/favicon.ico', async (request, reply) => {
  reply.code(404).send();
});


// Webhook endpoint
app.post('/webhooks', async (request, reply) => {
  try {
    const signature = request.headers['x-hub-signature-256'];
    const event = request.headers['x-github-event'];
    const id = request.headers['x-github-delivery'];
    
    // Get raw body as string
    const payload = JSON.stringify(request.body);
    
    await webhooks.verifyAndReceive({
      id,
      name: event,
      signature,
      payload
    });
    
    reply.code(200).send('OK');
  } catch (error) {
    logger.error('Webhook error:', error);
    reply.code(400).send(`Webhook error: ${error.message}`);
  }
});

app.post('/trigger-nibble/:owner/:repo', 
  { preHandler: [requireAuth].filter(Boolean) }, 
  async (request, reply) => {
    try {
      const { owner, repo } = request.params;
      
      // Enhanced validation
      if (!owner || !repo || 
        owner.length > 100 || repo.length > 100 ||
        !/^[a-zA-Z0-9_.-]+$/.test(owner) || 
        !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
        return reply.code(400).send({ error: 'Invalid repository parameters' });
      }
      
      logger.info({
        ip: request.ip,
        owner,
        repo,
        userAgent: request.headers['user-agent'],
        type: 'manual_trigger'
      }, 'Manual trigger requested');
            
      const result = await nibbleService.performNibble(owner, repo);
      return { success: true, result };
    } catch (error) {
      logger.error('Error in manual trigger:', error);
      reply.code(500);
      return { error: error.message };
    }
});

if (ENABLE_DEBUG_ENDPOINTS) {
  app.post('/debug/refresh-installations', 
    { preHandler: [requireAuth, ipAllowlist].filter(Boolean) },
    async (request, reply) => {
      try {
        logger.info(`Installation refresh requested by ${request.ip}`);
        const count = await nibbleService.refreshInstallationsFromGitHub();
        return { success: true, message: `Refreshed ${count} installations` };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    }
  );

  app.get('/debug/installations', 
    { preHandler: [requireAuth, ipAllowlist].filter(Boolean) },
    async (request, reply) => {
      logger.info(`Installation list requested by ${request.ip}`);
      const installations = nibbleService.getInstallations();
      return { installations };
    }
  );
} else {
  // Return 404 for debug endpoints when disabled
  app.get('/debug/*', async (request, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });
  
  app.post('/debug/*', async (request, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });
}

// Schedule nightly nibbles (2 AM UTC)
cron.schedule('0 2 * * *', async () => {
  logger.info('Running nightly nibble job...');
  await nibbleService.runNightlyNibbles();
});


const start = async () => {
  try {
    await app.listen({ port, host });
    logger.info(`Nibble GitHub App listening on host ${host} port ${port}`);
    logger.info('Ready to make your code slightly better, one bite at a time! 🍽️');
    
    // Security reminders
    if (!process.env.NIBBLE_API_SECRET) {
      logger.warn('⚠️  No NIBBLE_API_SECRET set in environment. Using random secret.');
      logger.warn('⚠️  Set NIBBLE_API_SECRET in your .env file for persistent API authentication.');
    }
    
    if (ENABLE_DEBUG_ENDPOINTS) {
      logger.warn('⚠️  Debug endpoints are enabled. Disable in production by removing ENABLE_DEBUG_ENDPOINTS.');
    }
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
