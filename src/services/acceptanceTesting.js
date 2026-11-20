const { logger } = require('../utils/logger');
const { ensureUserStory } = require('./userStory');
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

  async findManagedSprintTask(source, catalog) {
    const sprintTasks = this.sprintRouting.sprintTasks;
    if (!sprintTasks) throw new Error('Managed sprint tasks are disabled; cannot update the sprint item');
    const sprintTask = await sprintTasks.findItem(source, catalog);
    if (!sprintTask || sprintTask.archived) {
      throw new Error(`Master Backlog task ${source.id} has no active managed sprint task`);
    }
    return sprintTask;
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
      await ensureUserStory(this.clickup, source, this.config.backlogListId);
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
      } else if (await this.setStatus(copy, this.settings.testingStatus)) {
        logger.info(`Backlog task ${source.id}: moved existing testing task ${copy.id} to ${this.settings.testingStatus}`);
      } else {
        logger.info(`Backlog task ${source.id}: testing task ${copy.id} is already ${this.settings.testingStatus}`);
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
    const { completeStatus, backlogStatus, backlogCompleteStatus, sprintCompleteStatus } = this.settings;
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
      if (current !== normalize(backlogStatus) && current !== normalize(backlogCompleteStatus)) {
        return this.flag(testingTask, `Master Backlog task "${source.name}" (${source.url || source.id}) is in status ` +
          `${current.toUpperCase()}, not ${backlogStatus.toUpperCase()}, so it was not moved to ` +
          `${backlogCompleteStatus.toUpperCase()}. Please review its status manually.`);
      }
      const backlogChanged = await this.setStatus(source, backlogCompleteStatus);
      if (backlogChanged) {
        logger.info(`Backlog task ${source.id}: status set to ${backlogCompleteStatus} after testing task ${testingTask.id} completed`);
      }

      const lists = await Promise.all([false, true].map(archived =>
        this.clickup.getFolderLists(this.config.sprintFolderId, archived)));
      const sprints = [...new Set(lists.flat().map(list => String(list.id)))].map(id => ({ id }));
      const sprintTask = await this.findManagedSprintTask(source, { sprints });
      const sprintChanged = await this.setStatus(sprintTask, sprintCompleteStatus);
      if (sprintChanged) {
        logger.info(`Sprint task ${sprintTask.id}: status set to ${sprintCompleteStatus} after testing task ${testingTask.id} completed`);
      }
      return { outcome: backlogChanged || sprintChanged ? 'applied' : 'unchanged', sourceId };
    });
  }

  async returnToDevelopment(testingTask) {
    const { returnStatus, sprintFailedStatus, checkboxField, passedCheckboxField, backlogStatus } = this.settings;
    if (String(testingTask.list?.id) !== this.settings.listId ||
        statusName(testingTask) !== normalize(returnStatus) || testingTask.archived) {
      return { outcome: 'skipped', reason: 'Outside Testing Items, archived, or no longer in Return to Development' };
    }

    const passedCheckbox = this.clickup.getCustomField(testingTask, passedCheckboxField);
    let passedReset = false;
    if (!passedCheckbox?.id || passedCheckbox.type !== 'checkbox') {
      logger.warn(`Testing task ${testingTask.id} has no "${passedCheckboxField}" checkbox`);
    } else if (isChecked(passedCheckbox.value)) {
      await this.clickup.setCustomFieldValue(testingTask.id, passedCheckbox.id, false);
      passedReset = true;
    }

    const sourceId = sourceIdOf(testingTask);
    if (!sourceId) throw new Error(`Testing task ${testingTask.id} has no "Backlog task:" link`);
    return this.sprintRouting.withTaskLock(sourceId, async () => {
      const source = await this.clickup.getTask(sourceId);
      if (String(source.list?.id) !== this.config.backlogListId) {
        throw new Error(`Linked task ${sourceId} is not in Master Backlog`);
      }

      const catalog = await this.sprintRouting.loadCatalog();
      const { sprint, status } = this.sprintRouting.resolveAssignedSprint(source, catalog);
      if (source.archived || ![normalize(backlogStatus), status].includes(statusName(source))) {
        logger.warn(`Backlog task ${source.id}: no longer in ${backlogStatus} or ${status}; skipping return to development`);
        return {
          outcome: passedReset ? 'applied' : 'skipped',
          reason: 'Master Backlog task is archived or no longer in the expected status'
        };
      }

      const sprintTask = await this.findManagedSprintTask(source, catalog);
      if (String(sprintTask.list?.id) !== sprint.id) {
        throw new Error(`Sprint task ${sprintTask.id} is not in the Assigned Sprint "${sprint.name}"`);
      }
      const checkbox = this.clickup.getCustomField(sprintTask, checkboxField);
      if (!checkbox?.id || checkbox.type !== 'checkbox') {
        throw new Error(`Sprint task ${sprintTask.id} has no "${checkboxField}" checkbox`);
      }

      const statusChanged = await this.setStatus(sprintTask, sprintFailedStatus);
      const checked = isChecked(checkbox.value);
      if (checked) await this.clickup.setCustomFieldValue(sprintTask.id, checkbox.id, false);
      const backlogChanged = statusName(source) !== status;
      if (backlogChanged) await this.clickup.updateTask(source.id, { status });
      if (statusChanged || checked || backlogChanged) {
        logger.info(`Testing task ${testingTask.id}: returned sprint task ${sprintTask.id} to development; backlog task ${source.id} is in ${status.toUpperCase()}`);
      }
      return { outcome: passedReset || statusChanged || checked || backlogChanged ? 'applied' : 'unchanged' };
    });
  }

  async flag(testingTask, problem) {
    logger.error(`Testing task ${testingTask.id}: ${problem}`);
    await this.clickup.addTaskComment(testingTask.id, `[Workflow Agent] Automation could not complete acceptance testing: ${problem}`);
    return { outcome: 'flagged' };
  }
}

module.exports = { AcceptanceTesting };
