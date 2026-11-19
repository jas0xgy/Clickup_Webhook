const fs = require('fs');
const path = require('path');
const util = require('util');

const logDir = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const retentionDays = Number(process.env.LOG_RETENTION_DAYS || 30);
// Test runs (node --test) never write log files.
const fileLogging = process.env.LOG_TO_FILE !== 'false' && !process.env.NODE_TEST_CONTEXT;
let prunedFor = null;

const localDate = (date = new Date()) => date.toLocaleDateString('en-CA');

function prune(today) {
  if (prunedFor === today) return;
  prunedFor = today;
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const name of fs.readdirSync(logDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (match && Date.parse(`${match[1]}T23:59:59`) < cutoff) fs.unlinkSync(path.join(logDir, name));
  }
}

function writeFile(line) {
  if (!fileLogging) return;
  try {
    const today = localDate();
    fs.mkdirSync(logDir, { recursive: true });
    prune(today);
    fs.appendFileSync(path.join(logDir, `${today}.log`), `${line}\n`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ERROR: Could not write log file:`, error.message);
  }
}

function emit(level, consoleMethod, message, data, toConsole = true) {
  const prefix = `[${new Date().toISOString()}] ${level}: ${message}`;
  if (toConsole) consoleMethod(prefix, data);
  writeFile(data === '' ? prefix : `${prefix} ${typeof data === 'string' ? data :
    util.inspect(data, { depth: 8, breakLength: Infinity })}`);
}

/**
 * Logs to the console and to a daily file in logs/ (kept LOG_RETENTION_DAYS days).
 * Debug lines always reach the file; they reach the console only in development.
 */
const logger = {
  info: (message, data = '') => emit('INFO', console.log, message, data),
  error: (message, error = '') => emit('ERROR', console.error, message, error),
  warn: (message, data = '') => emit('WARN', console.warn, message, data),
  debug: (message, data = '') => emit('DEBUG', console.log, message, data, process.env.NODE_ENV === 'development'),
  // One JSON line per handled event, for tracing a task's history: search the logs for its ID.
  audit: record => emit('AUDIT', console.log, JSON.stringify(record), '', false)
};

module.exports = { logger };
