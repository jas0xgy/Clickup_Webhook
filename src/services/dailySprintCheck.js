const { logger } = require('../utils/logger');

class DailySprintCheck {
  constructor(run, config, now = () => new Date()) {
    this.run = run;
    this.config = config;
    this.now = now;
    this.formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    const local = this.localTime(now());
    // Starting after the scheduled time must not trigger an unexpected bulk update.
    this.lastRunDate = local.minutes >= this.scheduledMinutes() ? local.date : null;
    this.running = false;
    this.timer = null;
  }

  scheduledMinutes() {
    return this.config.hour * 60 + this.config.minute;
  }

  localTime(date) {
    const parts = Object.fromEntries(this.formatter.formatToParts(date).map(part => [part.type, part.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
  }

  async tick() {
    const local = this.localTime(this.now());
    if (this.running || local.date === this.lastRunDate || local.minutes < this.scheduledMinutes()) {
      return false;
    }
    this.lastRunDate = local.date;
    this.running = true;
    try {
      await this.run();
      return true;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) throw new Error('Daily sprint check is already running');
    this.timer = setInterval(() => {
      this.tick().catch(error => logger.error('Daily sprint reconciliation failed:', error.message));
    }, 30000);
    this.timer.unref();
    logger.info(`Daily sprint check scheduled for ${String(this.config.hour).padStart(2, '0')}:${String(this.config.minute).padStart(2, '0')} ${this.config.timeZone}`);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DailySprintCheck };
