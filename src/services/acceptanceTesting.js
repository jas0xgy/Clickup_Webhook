const { logger } = require('../utils/logger');
const { isManaged, sourceIdOf, linkedIds } = require('./sprintTasks');

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const statusName = task => normalize(task.status?.status);
const isChecked = value => value === true || value === 'true';

class AcceptanceTesting {
  constructor(clickup, config, sprintRouting) {
    this.clickup = clickup;
    this.config = config;
    this.settings = config.acceptanceTesting;
    this.sprintRouting = sprintRouting;
  }

  // Reuse an existing copy found via native links, then via a scan of the testing List.
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

  async setStatus(task, status) {
    if (statusName(task) === normalize(status)) return false;
    const list = await this.clickup.getList(task.list.id);
    const match = (list.statuses || []).find(value => normalize(value.status) === normalize(status));
    if (!match) throw new Error(`List ${task.list.id} has no "${status}" status for task ${task.id}`);
    await this.clickup.updateTask(task.id, { status: match.status });
    return true;
  }

  async handle(sprintTask) {
    const field = this.clickup.getCustomField(sprintTask, this.settings.checkboxField);
    if (!isChecked(field?.value)) {
      logger.debug(`Task ${sprintTask.id}: "${this.settings.checkboxField}" is no longer checked`);
      return { outcome: 'skipped' };
    }
    if (String(sprintTask.folder?.id) !== this.config.sprintFolderId) {
      throw new Error(`Task ${sprintTask.id} is not in the Sprint Folder; acceptance testing copies start from sprint tasks`);
    }
    const sourceId = sourceIdOf(sprintTask);
    if (!sourceId) throw new Error(`Sprint task ${sprintTask.id} has no "Backlog task:" link to its Master Backlog task`);

    return this.sprintRouting.withTaskLock(sourceId, async () => {
      const source = await this.clickup.getTask(sourceId);
      if (String(source.list?.id) !== this.config.backlogListId) {
        throw new Error(`Linked task ${sourceId} is not in Master Backlog`);
      }
      let copy = await this.findCopy(source);
      if (!copy) {
        const testingList = await this.clickup.getList(this.settings.listId);
        const status = (testingList.statuses || []).find(value =>
          normalize(value.status) === normalize(this.settings.testingStatus));
        if (!status) throw new Error(`Testing List has no "${this.settings.testingStatus}" status`);
        const details = this.sprintRouting.sprintTasks.copiedDetails(source);
        copy = await this.clickup.createTask(this.settings.listId, {
          name: source.name, status: status.status, links_to: source.id,
          description: details.description || `Backlog task: ${source.url || `https://app.clickup.com/t/${source.id}`}`,
          points: details.points, tags: details.tags,
          ...(details.priority ? { priority: details.priority } : {}),
          notify_all: false
        });
        if (!copy?.id) throw new Error('Testing task creation returned no task ID; inspect the testing List before retrying');
        logger.info(`Backlog task ${source.id}: created testing task ${copy.id}`);
      } else if (copy.archived) {
        const testingList = await this.clickup.getList(this.settings.listId);
        const status = (testingList.statuses || []).find(value =>
          normalize(value.status) === normalize(this.settings.testingStatus));
        if (!status) throw new Error(`Testing List has no "${this.settings.testingStatus}" status`);
        await this.clickup.updateTask(copy.id, { archived: false });
        await this.clickup.updateTask(copy.id, { status: status.status });
        logger.info(`Backlog task ${source.id}: restored archived testing task ${copy.id}`);
      } else {
        logger.info(`Backlog task ${source.id}: testing task ${copy.id} already exists`);
      }
      if (await this.setStatus(sprintTask, this.settings.sprintStatus)) {
        logger.info(`Sprint task ${sprintTask.id}: status set to ${this.settings.sprintStatus}`);
      }
      if (await this.setStatus(source, this.settings.backlogStatus)) {
        logger.info(`Backlog task ${source.id}: status set to ${this.settings.backlogStatus}`);
      }
      return { outcome: 'applied', sourceId, copyId: copy.id };
    });
  }

  async complete(testingTask) {
    const { completeStatus, backlogStatus, backlogCompleteStatus } = this.settings;
    if (String(testingTask.list?.id) !== this.settings.listId) {
      logger.debug(`Task ${testingTask.id}: not in the testing List; ignoring "${completeStatus}"`);
      return { outcome: 'skipped' };
    }
    if (statusName(testingTask) !== normalize(completeStatus)) {
      logger.debug(`Task ${testingTask.id}: no longer "${completeStatus}"`);
      return { outcome: 'skipped' };
    }
    const sourceId = sourceIdOf(testingTask);
    if (!sourceId) {
      return this.flag(testingTask, `this testing task has no "Backlog task:" link to its Master Backlog task, so the backlog task was not moved to ${backlogCompleteStatus.toUpperCase()}.`);
    }

    return this.sprintRouting.withTaskLock(sourceId, async () => {
      const source = await this.clickup.getTask(sourceId);
      if (String(source.list?.id) !== this.config.backlogListId) {
        return this.flag(testingTask, `linked task ${sourceId} is not in Master Backlog, so it was not moved to ${backlogCompleteStatus.toUpperCase()}.`);
      }
      const current = statusName(source);
      if (current === normalize(backlogCompleteStatus)) {
        logger.info(`Backlog task ${source.id}: already ${backlogCompleteStatus}`);
        return { outcome: 'unchanged', sourceId };
      }
      if (current !== normalize(backlogStatus)) {
        return this.flag(testingTask, `Master Backlog task "${source.name}" (${source.url || source.id}) is in status ` +
          `${current.toUpperCase()}, not ${backlogStatus.toUpperCase()}, so it was not moved to ` +
          `${backlogCompleteStatus.toUpperCase()}. Please review its status manually.`);
      }
      await this.setStatus(source, backlogCompleteStatus);
      logger.info(`Backlog task ${source.id}: status set to ${backlogCompleteStatus} after testing task ${testingTask.id} completed`);
      return { outcome: 'applied', sourceId };
    });
  }

  async flag(testingTask, problem) {
    logger.error(`Testing task ${testingTask.id}: ${problem}`);
    await this.clickup.addTaskComment(testingTask.id, `Automation could not complete acceptance testing: ${problem}`);
    return { outcome: 'flagged' };
  }
}

module.exports = { AcceptanceTesting };
