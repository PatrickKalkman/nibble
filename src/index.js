// src/index.js
require('dotenv').config();
const express = require('express');
const { Webhooks } = require('@octokit/webhooks');
const { App } = require('@octokit/app');
const cron = require('node-cron');
const NibbleService = require('./services/nibbleService');

const app = express();
const port = process.env.PORT || 3000;

// Initialize GitHub App
const githubApp = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: require('fs').readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8'),
});

// Initialize webhooks
const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET,
});

// Initialize our Nibble service
const nibbleService = new NibbleService(githubApp);

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
app.get('/', (req, res) => {
  res.json({ 
    status: 'Nibble is ready to improve your code!',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// Webhook endpoint
app.use('/webhooks', webhooks.middleware);

// Manual trigger endpoint (for testing)
app.post('/trigger-nibble/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const result = await nibbleService.performNibble(owner, repo);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule nightly nibbles (2 AM UTC)
cron.schedule('0 2 * * *', async () => {
  console.log('Running nightly nibble job...');
  await nibbleService.runNightlyNibbles();
});

app.listen(port, () => {
  console.log(`Nibble GitHub App listening on port ${port}`);
  console.log('Ready to make your code slightly better, one bite at a time! 🍽️');
});