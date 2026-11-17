/**
 * Simple logger utility for consistent logging across the application
 */
const logger = {
  info: (message, data = '') => {
    console.log(`[${new Date().toISOString()}] INFO: ${message}`, data);
  },
  error: (message, error = '') => {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error);
  },
  warn: (message, data = '') => {
    console.warn(`[${new Date().toISOString()}] WARN: ${message}`, data);
  },
  debug: (message, data = '') => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${new Date().toISOString()}] DEBUG: ${message}`, data);
    }
  }
};

module.exports = { logger };
