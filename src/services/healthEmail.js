const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

function buildHealthEmail(settings, { result, error, date = new Date(), note } = {}) {
  const when = date.toLocaleString('en-US', { timeZone: settings.timeZone, timeZoneName: 'short' });
  const lines = [`Daily check run: ${when}`];
  if (note) lines.push(note);
  if (error) {
    lines.push('', `The daily sprint check FAILED: ${error.message}`);
    for (const failure of error.errors || []) lines.push(`- ${failure.message}`);
  } else {
    const creation = result.sprintCreation || {};
    const sprints = creation.dryRun ? creation.planned : (creation.created || []).map(sprint => sprint.name);
    lines.push('',
      `Backlog tasks scanned: ${result.scanned}`,
      `Tasks evaluated: ${result.evaluated}`,
      `Tasks updated: ${result.plans.filter(plan => plan.outcome === 'updated').length}`,
      `Sprints ${creation.dryRun ? 'that would be created' : 'created'}: ${sprints?.length ? sprints.join(', ') : 'none'}`);
    if (creation.error) lines.push(`Sprint creation FAILED: ${creation.error}`);
  }
  const healthy = !error && !result.sprintCreation?.error;
  return {
    to: settings.to,
    subject: healthy ? settings.subject : settings.failureSubject,
    text: lines.join('\n')
  };
}

function smtpTransport(env = process.env) {
  if (env.GMAIL_CLIENT_ID || env.GMAIL_CLIENT_SECRET || env.GMAIL_REFRESH_TOKEN) {
    const missing = ['SMTP_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].filter(key => !env[key]);
    if (missing.length > 0) {
      logger.warn(`Health email skipped: set ${missing.join(', ')} in .env (run npm run gmail:auth for the refresh token)`);
      return null;
    }
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2', user: env.SMTP_USER, clientId: env.GMAIL_CLIENT_ID,
        clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN
      }
    });
  }
  const missing = ['SMTP_USER', 'SMTP_PASS'].filter(key => !env[key]);
  if (missing.length > 0) {
    logger.warn(`Health email skipped: set ${missing.join(' and ')} in .env`);
    return null;
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT || 587) === 465,
    requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
  });
}

// Never throws: email problems are logged so they cannot break the daily check.
async function sendHealthEmail(settings, outcome, { transport = smtpTransport(), env = process.env } = {}) {
  if (!settings?.enabled || !transport) return false;
  const message = { ...buildHealthEmail(settings, outcome), from: env.SMTP_FROM || env.SMTP_USER };
  try {
    await transport.sendMail(message);
    logger.info(`Health email "${message.subject}" sent to ${message.to}`);
    return true;
  } catch (error) {
    logger.error('Health email failed to send:', error.message);
    return false;
  }
}

module.exports = { buildHealthEmail, sendHealthEmail };
