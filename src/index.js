require('dotenv').config();

const express = require('express');
const webhookRouter = require('./routes/webhook');
const { logger } = require('./utils/logger');
const { DailySprintCheck } = require('./services/dailySprintCheck');
const { reconcileSprints } = require('./services/webhookHandler');
const { sendHealthEmail } = require('./services/healthEmail');
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
      let result;
      try {
        result = await reconcileSprints();
      } catch (error) {
        await sendHealthEmail(sprintRouting.healthEmail, { error });
        throw error;
      }
      logger.info('Daily sprint reconciliation finished', {
        createdSprints: result.sprintCreation.created.map(sprint => sprint.name),
        scanned: result.scanned, evaluated: result.evaluated,
        updated: result.plans.filter(plan => plan.outcome === 'updated').length
      });
      await sendHealthEmail(sprintRouting.healthEmail, { result });
    }, sprintRouting.daily);
    dailyCheck.start();
    server.on('close', () => dailyCheck.stop());
  }
});

server.on('error', (error) => {
  logger.error('Failed to start ClickUp webhook service:', error.message);
  process.exitCode = 1;
});
