const { logger } = require('../utils/logger');

const dayMs = 86400000;
const maxCreatedPerRun = 10;

function localDate(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Epoch ms of local midnight for a calendar day (expressed as a UTC-midnight timestamp) in timeZone.
function zonedMidnight(day, timeZone) {
  let result = day - zoneOffset(day, timeZone);
  result = day - zoneOffset(result, timeZone);
  return result;
}

const label = day => `${new Date(day).getUTCMonth() + 1}/${new Date(day).getUTCDate()}`;
const sprintNumber = name => {
  const match = /^Sprint\s+(\d+)\b/i.exec(name.trim());
  return match ? Number(match[1]) : null;
};

// Plans consecutive sprints after the latest one until `futureCount` sprints start after `now`.
function planSprints(catalog, now, { futureCount, timeZone }) {
  if (catalog.sprints.length === 0) {
    throw new Error('Sprint Folder has no sprints to continue from; create the first sprint manually');
  }
  let future = catalog.active.filter(sprint => sprint.start > now).length;
  if (future >= futureCount) return [];

  const last = catalog.sprints.reduce((latest, sprint) => sprint.end > latest.end ? sprint : latest);
  const firstDay = localDate(last.start, timeZone);
  const lastDay = localDate(last.end, timeZone);
  const lengthDays = Math.round((lastDay - firstDay) / dayMs) + 1;
  if (!(lengthDays > 0)) throw new Error(`Sprint "${last.name}" has an invalid date range`);
  const numbers = catalog.sprints.map(sprint => sprintNumber(sprint.name)).filter(Number.isInteger);
  if (sprintNumber(last.name) === null || numbers.length === 0) {
    throw new Error(`Latest sprint "${last.name}" is not named "Sprint <number> (...)"; cannot number the next sprint`);
  }

  const planned = [];
  let number = Math.max(...numbers);
  let nextDay = lastDay + dayMs;
  while (future < futureCount) {
    if (planned.length >= maxCreatedPerRun) {
      throw new Error(`Refusing to create more than ${maxCreatedPerRun} sprints in one run; check the Sprint Folder dates`);
    }
    number += 1;
    const endDay = nextDay + (lengthDays - 1) * dayMs;
    const sprint = {
      name: `Sprint ${number} (${label(nextDay)} - ${label(endDay)})`,
      start: zonedMidnight(nextDay, timeZone),
      end: zonedMidnight(endDay + dayMs, timeZone) - 1
    };
    planned.push(sprint);
    if (sprint.start > now) future += 1;
    nextDay = endDay + dayMs;
  }
  return planned;
}

class SprintCreation {
  constructor(clickup, config, sprintRouting, now = Date.now) {
    this.clickup = clickup;
    this.config = config;
    this.settings = config.sprintCreation;
    this.sprintRouting = sprintRouting;
    this.now = now;
  }

  async ensureFutureSprints({ dryRun = false } = {}) {
    if (!this.settings?.enabled) return { dryRun, planned: [], created: [] };
    const catalog = await this.sprintRouting.loadCatalog();
    const planned = planSprints(catalog, this.now(), {
      futureCount: this.settings.futureSprints, timeZone: this.config.daily.timeZone
    });
    const created = [];
    if (!dryRun) {
      for (const sprint of planned) {
        const list = await this.clickup.createList(this.config.sprintFolderId, {
          name: sprint.name, start_date: sprint.start, due_date: sprint.end,
          start_date_time: false, due_date_time: false
        });
        if (!list?.id || Number(list.start_date) !== sprint.start || Number(list.due_date) !== sprint.end) {
          throw new Error(`Sprint "${sprint.name}" was created without the requested dates; fix it in ClickUp before the next run`);
        }
        created.push({ id: String(list.id), name: sprint.name });
        logger.info(`Created sprint List ${list.id} "${sprint.name}"`);
      }
    }
    return { dryRun, planned: planned.map(sprint => sprint.name), created };
  }
}

module.exports = { SprintCreation, planSprints, zonedMidnight };
