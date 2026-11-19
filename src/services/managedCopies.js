const { logger } = require('../utils/logger');
const { isManaged, linkedIds } = require('./sprintTasks');

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

// Archives every unarchived managed copy of a backlog task in one List, found by native link or backlink line.
async function archiveManagedCopies(clickup, source, listId, label) {
  const candidates = new Map();
  for (const id of linkedIds(source)) {
    try {
      const item = await clickup.getTask(id);
      if (String(item.list?.id) === String(listId)) candidates.set(item.id, item);
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
  }
  for (const item of await clickup.getListTasks(listId)) {
    if (!candidates.has(item.id)) {
      candidates.set(item.id, typeof item.description === 'string' ? item : await clickup.getTask(item.id));
    }
  }
  const archived = [];
  for (const item of candidates.values()) {
    if (item.archived || !isManaged(item, source.id)) continue;
    await clickup.updateTask(item.id, { archived: true });
    archived.push(item.id);
    logger.info(`Backlog task ${source.id}: archived ${label} task ${item.id}`);
  }
  if (archived.length === 0) logger.debug(`Backlog task ${source.id}: no active ${label} task to archive`);
  return { outcome: archived.length > 0 ? 'applied' : 'unchanged', archived };
}

// Runs while the webhook handler holds the backlog task's lock; re-checks the live status first.
async function archiveCopiesOnStatus({ clickup, config, task, settings, label }) {
  if (String(task.list?.id) !== config.backlogListId) return { outcome: 'skipped' };
  const statuses = settings.archiveOnStatuses.map(normalize);
  if (!statuses.includes(normalize(task.status?.status))) {
    logger.debug(`Task ${task.id}: status changed again; not archiving ${label} tasks`);
    return { outcome: 'skipped' };
  }
  return archiveManagedCopies(clickup, task, settings.listId, label);
}

module.exports = { archiveManagedCopies, archiveCopiesOnStatus };
