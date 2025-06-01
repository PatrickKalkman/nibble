import 'dotenv/config';
import fastify from 'fastify';
import { Webhooks } from '@octokit/webhooks';
import { createAppAuth } from '@octokit/auth-app';
import cron from 'node-cron';
import { readFileSync } from 'fs';
import NibbleService from './services/nibbleService.js';

const port = process.env.PORT || 3000;

const appId      = process.env.GITHUB_APP_ID;
const privateKey = readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');

const appAuth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8'),
});

const appAdapter = {
  // ── JWT-scoped Octokit ─────────────────────────────────────────────
  async auth() {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey }
    });
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

// Webhook handlers
webhooks.on('installation.created', async ({ payload }) => {
  console.log(`Nibble installed on ${payload.installation.account.login}`);
  // Optionally store installation info
  await nibbleService.handleInstallation(payload.installation);
});

webhooks.on('push', async ({ payload }) => {
  // Only process pushes to main/master branch
  if (payload.ref === 'refs/heads/main' || payload.ref === 'refs/heads/master') {
    console.log(`Push detected to ${payload.repository.full_name}`);
    // Trigger a nibble analysis (could be async)
    await nibbleService.scheduleDailyNibble(payload.repository, payload.installation);
  }
});

// Health check endpoint
app.get('/', async (request, reply) => {
  return { 
    status: 'Nibble is ready to improve your code!',
    version: '1.0.0',
    uptime: process.uptime()
  };
});

// Webhook endpoint
app.post('/webhooks', {
  config: {
    rawBody: true
  }
}, async (request, reply) => {
  try {
    const signature = request.headers['x-hub-signature-256'];
    const event = request.headers['x-github-event'];
    const id = request.headers['x-github-delivery'];
    
    await webhooks.verifyAndReceive({
      id,
      name: event,
      signature,
      payload: request.rawBody
    });
    
    reply.code(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    reply.code(400).send(`Webhook error: ${error.message}`);
  }
});

// Manual trigger endpoint (for testing)
app.post('/trigger-nibble/:owner/:repo', async (request, reply) => {
  try {
    const { owner, repo } = request.params;
    const result = await nibbleService.performNibble(owner, repo);
    return { success: true, result };
  } catch (error) {
    console.error('Error in manual trigger:', error);
    reply.code(500);
    return { error: error.message };
  }
});

app.post('/debug/refresh-installations', async (request, reply) => {
  try {
    const count = await nibbleService.refreshInstallationsFromGitHub();
    return { success: true, message: `Refreshed ${count} installations` };
  } catch (error) {
    reply.code(500);
    return { error: error.message };
  }
});

app.get('/debug/installations', async (request, reply) => {
  const installations = nibbleService.getInstallations();
  return { installations };
});

// Schedule nightly nibbles (2 AM UTC)
cron.schedule('0 2 * * *', async () => {
  console.log('Running nightly nibble job...');
  await nibbleService.runNightlyNibbles();
});


const start = async () => {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Nibble GitHub App listening on port ${port}`);
    console.log('Ready to make your code slightly better, one bite at a time! 🍽️');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
