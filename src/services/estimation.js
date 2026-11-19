const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');
const { isManaged, sourceIdOf, linkedIds } = require('./sprintTasks');

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const statusName = task => normalize(task.status?.status);

class Estimation {
  constructor(clickup, config, sprintRouting) {
    this.clickup = clickup;
    this.config = config;
    this.settings = config.estimation;
    this.sprintRouting = sprintRouting;
  }

  // Reuse an existing copy found via native links, then via a scan of the estimation List.
  async findCopy(source) {
    for (const id of linkedIds(source)) {
      let item;
      try {
        item = await this.clickup.getTask(id);
      } catch (error) {
        if (error.response?.status === 404) continue;
        throw error;
      }
      if (String(item.list?.id) === this.settings.listId && isManaged(item, source.id)) return item;
    }
    const pages = await Promise.all([
      this.clickup.getListTasks(this.settings.listId),
      this.clickup.getListTasks(this.settings.listId, { archived: true })
    ]);
    for (const item of pages.flat()) {
      const full = typeof item.description === 'string' ? item : await this.clickup.getTask(item.id);
      if (isManaged(full, source.id)) return full;
    }
    return null;
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
    const existing = await this.findCopy(source);
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

  async complete(estimateTask) {
    const { readyStatus, estimateField } = this.settings;
    if (String(estimateTask.list?.id) !== this.settings.listId) {
      logger.debug(`Task ${estimateTask.id}: not in the estimation List; ignoring "${readyStatus}"`);
      return { outcome: 'skipped' };
    }
    if (statusName(estimateTask) !== normalize(readyStatus)) {
      logger.debug(`Task ${estimateTask.id}: no longer "${readyStatus}"`);
      return { outcome: 'skipped' };
    }
    const estimate = numberValue(this.clickup.getCustomField(estimateTask, estimateField)?.value);
    if (!(estimate > 0)) {
      return this.flag(estimateTask, `${estimateField} is empty or zero, so it was not copied to the Master Backlog task. ` +
        `Enter a non-zero ${estimateField} and move this task to ${readyStatus.toUpperCase()} again.`);
    }
    const sourceId = sourceIdOf(estimateTask);
    if (!sourceId) {
      return this.flag(estimateTask, `this task has no "Backlog task:" link to its Master Backlog task, so ${estimateField} was not copied.`);
    }

    return this.sprintRouting.withTaskLock(sourceId, async () => {
      const source = await this.clickup.getTask(sourceId);
      if (String(source.list?.id) !== this.config.backlogListId) {
        return this.flag(estimateTask, `linked task ${sourceId} is not in Master Backlog, so ${estimateField} was not copied.`);
      }
      const target = this.clickup.getCustomField(source, estimateField);
      if (!target?.id || target.type !== 'number') {
        throw new Error(`Master Backlog task ${source.id} has no numeric "${estimateField}" field`);
      }
      if (numberValue(target.value) === estimate) {
        logger.info(`Backlog task ${source.id}: ${estimateField} is already ${estimate}`);
        return { outcome: 'unchanged', sourceId };
      }
      await this.clickup.setCustomFieldValue(source.id, target.id, estimate);
      logger.info(`Backlog task ${source.id}: ${estimateField} set to ${estimate} from estimation task ${estimateTask.id}`);
      return { outcome: 'applied', sourceId, estimate };
    });
  }

  async flag(estimateTask, problem) {
    logger.error(`Estimation task ${estimateTask.id}: ${problem}`);
    await this.clickup.addTaskComment(estimateTask.id, `Automation could not update the estimate: ${problem}`);
    return { outcome: 'flagged' };
  }
}

module.exports = { Estimation };
