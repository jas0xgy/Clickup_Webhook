const crypto = require('crypto');
const { logger } = require('./logger');

/**
 * Validates the webhook signature to ensure the request came from ClickUp
 * @param {Object} req - Express request object
 * @returns {boolean} - True if signature is valid
 */
function validateWebhookSignature(req) {
  const signature = req.headers['x-signature'];
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;

  if (!secret || secret === 'your_webhook_secret_here') {
    logger.warn('Missing signature or secret for validation');
    return false;
  }

  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) ||
      !Buffer.isBuffer(req.rawBody)) {
    logger.warn('Missing or malformed webhook signature or raw body');
    return false;
  }

  const hash = crypto.createHmac('sha256', secret).update(req.rawBody).digest();
  const isValid = crypto.timingSafeEqual(hash, Buffer.from(signature, 'hex'));
  
  if (!isValid) {
    logger.warn('Webhook signature mismatch');
  }

  return isValid;
}

module.exports = { validateWebhookSignature };
