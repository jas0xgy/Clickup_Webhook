require('dotenv').config();

const express = require('express');
const webhookRouter = require('./routes/webhook');
const { logger } = require('./utils/logger');
const { DailySprintCheck } = require('./services/dailySprintCheck');
const { reconcileSprints } = require('./services/webhookHandler');
const { sprintRouting } = require('./config');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));
app.use('/webhook', webhookRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(port, () => {
  logger.info(`ClickUp webhook service listening on port ${server.address().port}`);
  if (sprintRouting.daily.enabled) {
    const dailyCheck = new DailySprintCheck(async () => {
      const result = await reconcileSprints();
      logger.info('Daily sprint reconciliation finished', {
        scanned: result.scanned, evaluated: result.evaluated,
        updated: result.plans.filter(plan => plan.outcome === 'updated').length
      });
    }, sprintRouting.daily);
    dailyCheck.start();
    server.on('close', () => dailyCheck.stop());
  }
});

server.on('error', (error) => {
  logger.error('Failed to start ClickUp webhook service:', error.message);
  process.exitCode = 1;
});
