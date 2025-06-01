// src/index.js
import 'dotenv/config';
import fastify from 'fastify';
import { Webhooks } from '@octokit/webhooks';
import { createAppAuth } from '@octokit/auth-app';
import cron from 'node-cron';
import { readFileSync } from 'fs';
import NibbleService from './services/nibbleService.js';

const port = process.env.PORT || 3000;

// Initialize GitHub App Auth
const appAuth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8'),
});

// Initialize webhooks
const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET,
});

// Initialize our Nibble service
const nibbleService = new NibbleService(appAuth);

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

// Start the server
const app = fastify({ logger: true });

// Health check endpoint
app.get('/', async (request, reply) => {
  return { 
    status: 'Nibble is ready to improve your code!',
    version: '1.0.0',
    uptime: process.uptime()
  };
});

// Webhook endpoint
app.post('/webhooks', async (request, reply) => {
  try {
    await webhooks.verifyAndReceive({
      id: request.headers['x-github-delivery'],
      name: request.headers['x-github-event'],
      signature: request.headers['x-hub-signature-256'],
      payload: JSON.stringify(request.body)
    });
    return { success: true };
  } catch (error) {
    reply.code(400);
    return { error: error.message };
  }
});

// Manual trigger endpoint (for testing)
app.post('/trigger-nibble/:owner/:repo', async (request, reply) => {
  try {
    const { owner, repo } = request.params;
    const result = await nibbleService.performNibble(owner, repo);
    return { success: true, result };
  } catch (error) {
    reply.code(500);
    return { error: error.message };
  }
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
