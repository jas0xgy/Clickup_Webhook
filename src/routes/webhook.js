const express = require('express');
const { handleWebhook } = require('../services/webhookHandler');
const { validateWebhookSignature } = require('../utils/security');
const { logger } = require('../utils/logger');

const router = express.Router();

router.post('/clickup', async (req, res) => {
  try {
    // Validate webhook signature for security
    const isValid = validateWebhookSignature(req);
    if (!isValid) {
      logger.warn('Invalid webhook signature received');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    logger.info(`Received webhook event: ${event.event}`);

    // Handle the webhook asynchronously
    handleWebhook(event).catch((error) => {
      logger.error('Error processing webhook:', error);
    });

    // Respond immediately to prevent retries
    res.status(200).json({ success: true, message: 'Webhook received' });
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
