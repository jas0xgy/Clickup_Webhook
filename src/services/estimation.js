const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');
const { ensureUserStory } = require('./userStory');
const { isManaged, sourceIdOf, linkedIds } = require('./sprintTasks');

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const statusName = task => normalize(task.status?.status);
const duplicateReason = (sourceId, copies) =>
  `Multiple active estimation copies for backlog task ${sourceId}: ${copies.map(copy => copy.id).sort().join(', ')}. Resolve the duplicate copies before retrying.`;

class Estimation {
  constructor(clickup, config, sprintRouting) {
    this.clickup = clickup;
    this.config = config;
    this.settings = config.estimation;
    this.sprintRouting = sprintRouting;
  }

  async findCopies(source, { archived = false } = {}) {
    const copies = new Map();
    const consider = item => {
      if (String(item.list?.id) === this.settings.listId && Boolean(item.archived) === archived &&
          isManaged(item, source.id)) copies.set(item.id, item);
    };
    const listed = new Set();
    for (const item of await this.clickup.getListTasks(this.settings.listId, { archived })) {
      listed.add(item.id);
      consider(typeof item.description === 'string' ? item : await this.clickup.getTask(item.id));
    }
    for (const id of linkedIds(source)) {
      if (listed.has(id)) continue;
      try {
        consider(await this.clickup.getTask(id));
      } catch (error) {
        if (error.response?.status !== 404) throw error;
      }
    }
    return [...copies.values()];
  }

  flagDuplicateCopies(sourceId, copies) {
    const reason = duplicateReason(sourceId, copies);
    logger.warn(reason);
    return { outcome: 'flagged', reason };
  }

  async initialStatus() {
    const list = await this.clickup.getList(this.settings.listId);
    const status = (list.statuses || []).find(value =>
      normalize(value.status) === normalize(this.settings.initialStatus));
    if (!status) throw new Error(`Estimation List has no "${this.settings.initialStatus}" status`);
    return status.status;
  }

  // Called while the webhook handler already holds the backlog task's lock.
  async request(source) {
    if (String(source.list?.id) !== this.config.backlogListId) {
      logger.debug(`Task ${source.id}: not in Master Backlog; ignoring "${this.settings.triggerStatus}"`);
      return { outcome: 'skipped' };
    }
    if (statusName(source) !== normalize(this.settings.triggerStatus)) {
      logger.debug(`Task ${source.id}: no longer "${this.settings.triggerStatus}"`);
      return { outcome: 'skipped' };
    }
    const active = await this.findCopies(source);
    if (active.length > 1) return this.flagDuplicateCopies(source.id, active);
    const existing = active[0] ?? (await this.findCopies(source, { archived: true }))[0];
    await ensureUserStory(this.clickup, source, this.config.backlogListId);
    if (existing?.archived) {
      await this.clickup.updateTask(existing.id, { archived: false });
      await this.clickup.updateTask(existing.id, { status: await this.initialStatus() });
      logger.info(`Backlog task ${source.id}: restored archived estimation task ${existing.id}`);
      return { outcome: 'restored', copyId: existing.id };
    }
    if (existing) {
      logger.info(`Backlog task ${source.id}: estimation task ${existing.id} already exists`);
      return { outcome: 'unchanged', copyId: existing.id };
    }
    const { description, tags } = this.sprintRouting.sprintTasks.copiedText(source);
    const copy = await this.clickup.createTask(this.settings.listId, {
      name: source.name, status: await this.initialStatus(), links_to: source.id,
      description: description || `Backlog task: ${source.url || `https://app.clickup.com/t/${source.id}`}`,
      tags, notify_all: false
    });
    if (!copy?.id) throw new Error('Estimation task creation returned no task ID; inspect the estimation List before retrying');
    logger.info(`Backlog task ${source.id}: created estimation task ${copy.id}`);
    return { outcome: 'applied', copyId: copy.id };
  }

  // Called while the webhook handler holds the backlog task's lock.
  async deleteInvalidCopy(source) {
    if (String(source.list?.id) !== this.config.backlogListId) return { outcome: 'skipped' };
    if (statusName(source) !== this.settings.resetStatus) {
      logger.debug(`Task ${source.id}: status changed again; not deleting its estimation copy`);
      return { outcome: 'skipped' };
    }

    const active = await this.findCopies(source);
    if (active.length > 1) return this.flagDuplicateCopies(source.id, active);
    const copy = active[0] ?? (await this.findCopies(source, { archived: true }))[0];
    if (!copy || copy.id === source.id) return { outcome: 'unchanged' };
    try {
      const currentCopy = await this.clickup.getTask(copy.id);
      if (String(currentCopy.list?.id) !== this.settings.listId || !isManaged(currentCopy, source.id)) {
        logger.warn(`Task ${source.id}: estimation copy ${copy.id} no longer matches; not deleting it`);
        return { outcome: 'skipped' };
      }
      const currentSource = await this.clickup.getTask(source.id);
      if (String(currentSource.list?.id) !== this.config.backlogListId ||
          statusName(currentSource) !== this.settings.resetStatus) {
        logger.debug(`Task ${source.id}: no longer in Master Backlog at ${this.settings.resetStatus}; not deleting its estimation copy`);
        return { outcome: 'skipped' };
      }
      await this.clickup.deleteTask(copy.id);
    } catch (error) {
      if (error.response?.status !== 404) throw error;
      return { outcome: 'unchanged' };
    }
    logger.info(`Backlog task ${source.id}: deleted invalid estimation task ${copy.id}`);
    return { outcome: 'applied', copyId: copy.id };
  }

  async complete(estimateTask) {
    const record = { estimationTaskId: estimateTask.id, backlogTaskId: null, estimate: null, outcome: 'failed' };
    try {
      const result = await this.applyEstimate(estimateTask, record);
      record.outcome = result.outcome;
      if (result.reason) record.reason = result.reason;
      return result;
    } finally {
      logger.info('Estimation handoff', JSON.stringify(record));
    }
  }

  async applyEstimate(estimateTask, record) {
    const { readyStatus, estimateField } = this.settings;
    if (String(estimateTask.list?.id) !== this.settings.listId) {
      logger.debug(`Task ${estimateTask.id}: not in the estimation List; ignoring "${readyStatus}"`);
      return { outcome: 'skipped' };
    }
    const sourceId = sourceIdOf(estimateTask);
    record.backlogTaskId = sourceId;
    const estimate = numberValue(this.clickup.getCustomField(estimateTask, estimateField)?.value);
    record.estimate = Number.isFinite(estimate) ? estimate : null;
    if (estimateTask.archived || statusName(estimateTask) !== normalize(readyStatus)) {
      logger.debug(`Task ${estimateTask.id}: archived or no longer "${readyStatus}"`);
      return { outcome: 'skipped' };
    }
    if (!(estimate > 0)) {
      return this.flag(estimateTask, `${estimateField} is empty or zero, so it was not copied to the Master Backlog task. ` +
        `Enter a non-zero ${estimateField} and move this task to ${readyStatus.toUpperCase()} again.`);
    }
    if (!sourceId) {
      return this.flag(estimateTask, `this task has no "Backlog task:" link to its Master Backlog task, so ${estimateField} was not copied.`);
    }

    return this.sprintRouting.withTaskLock(sourceId, async () => {
      const source = await this.clickup.getTask(sourceId);
      if (String(source.list?.id) !== this.config.backlogListId) {
        return this.flag(estimateTask, `linked task ${sourceId} is not in Master Backlog, so ${estimateField} was not copied.`);
      }
      const active = await this.findCopies(source);
      // The fetched triggering task may not yet be visible in the list response.
      if (!active.some(copy => copy.id === estimateTask.id)) active.push(estimateTask);
      if (active.length > 1) return this.flag(estimateTask, duplicateReason(sourceId, active));
      const target = this.clickup.getCustomField(source, estimateField);
      if (!target?.id || target.type !== 'number') {
        throw new Error(`Master Backlog task ${source.id} has no numeric "${estimateField}" field`);
      }
      if (numberValue(target.value) === estimate) {
        return { outcome: 'unchanged', sourceId };
      }
      await this.clickup.setCustomFieldValue(source.id, target.id, estimate);
      return { outcome: 'applied', sourceId, estimate };
    });
  }

  async flag(estimateTask, problem) {
    logger.error(`Estimation task ${estimateTask.id}: ${problem}`);
    await this.clickup.addTaskComment(estimateTask.id, `[Workflow Agent] Automation could not update the estimate: ${problem}`);
    return { outcome: 'flagged', reason: problem };
  }
}

module.exports = { Estimation };
