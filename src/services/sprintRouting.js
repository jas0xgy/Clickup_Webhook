const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');
const { SprintTasks } = require('./sprintTasks');

const protectedStatuses = new Set(['in testing', 'ready to deploy', 'deployed', 'complete']);
const sprintOffsets = new Map([['sprint 0', 0], ['sprint +1', 1], ['sprint +2', 2]]);
const backlogStatuses = new Set(['new backlog', 'awaiting estimation', 'ready to schedule']);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isBlank = value => value == null || (typeof value === 'string' && value.trim() === '');
const statusName = value => normalize(typeof value === 'string' ? value : value?.status);

function isProtected(task) {
  return protectedStatuses.has(statusName(task.status)) ||
    task.status?.type === 'done' || task.status?.type === 'closed';
}

function buildCatalog(lists, completedSprintIds, statuses) {
  if (!Array.isArray(completedSprintIds) ||
      completedSprintIds.some(id => typeof id !== 'string' || id.trim() === '')) {
    throw new Error('completedSprintIds must contain sprint List ID strings');
  }
  const completed = new Set(completedSprintIds);
  const sprints = lists.map(list => {
    if (!list.id || typeof list.name !== 'string' || !list.name.trim() ||
        isBlank(list.start_date) || isBlank(list.due_date) ||
        !Number.isFinite(Number(list.start_date)) || !Number.isFinite(Number(list.due_date)) ||
        Number(list.start_date) > Number(list.due_date)) {
      throw new Error(`Sprint List ${list.id || '(unknown)'} has missing or invalid name/dates`);
    }
    return {
      id: String(list.id), name: list.name, start: Number(list.start_date),
      end: Number(list.due_date), archived: list.archived === true,
      completed: completed.has(String(list.id))
    };
  }).sort((a, b) => a.start - b.start);

  for (const id of completed) {
    if (!sprints.some(sprint => sprint.id === id)) {
      throw new Error(`Completed sprint ${id} was not found in the configured Sprint Folder`);
    }
  }
  if (new Set(sprints.map(sprint => sprint.name.trim())).size !== sprints.length) {
    throw new Error('Sprint names must be unique to resolve the Assigned Sprint text field');
  }
  const active = sprints.filter(sprint => !sprint.archived && !sprint.completed);
  for (let index = 1; index < active.length; index += 1) {
    if (active[index].start <= active[index - 1].end) {
      throw new Error(`Sprint dates overlap: "${active[index - 1].name}" and "${active[index].name}"`);
    }
  }
  return { sprints, active, statuses: statuses.map(statusName) };
}

function currentSprintIndex(catalog, now) {
  const index = catalog.active.findIndex(sprint => sprint.start <= now && now <= sprint.end);
  if (index === -1) {
    throw new Error('No uncompleted, unarchived sprint contains today; refusing to guess a current sprint');
  }
  return index;
}

function assignedSprintStatus(sprint, catalog, now) {
  if (sprint.completed) return 'in testing';
  if (sprint.end < now) return 'sprint 0';
  if (!sprint.archived && sprint.start <= now && now <= sprint.end) return 'sprint 0';
  const offset = catalog.active.indexOf(sprint) - currentSprintIndex(catalog, now);
  if (sprint.archived || offset < 0 || offset > 2) {
    throw new Error(`Assigned sprint "${sprint.name}" cannot be represented by SPRINT 0, +1, or +2`);
  }
  return [...sprintOffsets].find(([, value]) => value === offset)[0];
}

class SprintRouting {
  constructor(clickup, config, now = Date.now) {
    this.clickup = clickup;
    this.config = config;
    this.now = now;
    this.pending = new Map();
    this.sprintTasks = config.sprintTasks?.enabled ? new SprintTasks(clickup, config) : null;
  }

  async withTaskLock(taskId, action) {
    const previous = this.pending.get(taskId) || Promise.resolve();
    const operation = previous.then(action, action);
    this.pending.set(taskId, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(taskId) === operation) this.pending.delete(taskId);
    }
  }

  isEligible(task) {
    return String(task.list?.id) === this.config.backlogListId && !task.archived &&
      numberValue(this.clickup.getCustomField(task, 'Effort Estimate')?.value) > 0;
  }

  async loadCatalog() {
    const [active, archived, backlog] = await Promise.all([
      this.clickup.getFolderLists(this.config.sprintFolderId, false),
      this.clickup.getFolderLists(this.config.sprintFolderId, true),
      this.clickup.getList(this.config.backlogListId)
    ]);
    const lists = [...new Map([...active, ...archived].map(list => [String(list.id), list])).values()];
    if (!Array.isArray(backlog.statuses)) throw new Error('Master Backlog status metadata is missing');
    return buildCatalog(lists, this.config.completedSprintIds, backlog.statuses);
  }

  async reconcileTask(task, { changes = [], catalog, dryRun = false } = {}) {
    const skip = reason => {
      logger.debug(`Task ${task.id}: sprint routing skipped: ${reason}`);
      return { taskId: task.id, outcome: 'skipped', reason };
    };
    if (!this.isEligible(task)) return skip('Outside Master Backlog, archived, or without a positive estimate');
    const assigned = this.clickup.getCustomField(task, 'Assigned Sprint');
    const detailFields = this.sprintTasks ? ['product', 'persona'] : [];
    const relevantFields = ['effort estimate', 'assigned sprint', ...detailFields];
    const statusChanges = changes.filter(change => change.field === 'status');
    const nameChanges = this.sprintTasks ? changes.filter(change => change.field === 'name') : [];
    const fieldChanges = changes.filter(change => change.field === 'custom_field' &&
      relevantFields.includes(normalize(change.custom_field?.name)) &&
      this.clickup.getCustomField(task, change.custom_field.name)?.id === change.custom_field.id);
    if (changes.length > 0 && statusChanges.length === 0 && fieldChanges.length === 0 && nameChanges.length === 0) {
      return skip('Event fields no longer match current task fields');
    }
    const matchingStatusChange = statusChanges.find(change =>
      statusName(change.after) === statusName(task.status));
    if (statusChanges.length > 0 && !matchingStatusChange) {
      return skip('Stale status event; current status no longer matches');
    }
    const assignmentChanges = fieldChanges.filter(change => change.custom_field.id === assigned?.id);
    if (assignmentChanges.length > 0 && !assignmentChanges.some(change =>
      (isBlank(change.after) && isBlank(assigned.value)) ||
      (typeof change.after === 'string' && typeof assigned.value === 'string' &&
        change.after.trim() === assigned.value.trim()))) {
      return skip('Stale assignment event; current Assigned Sprint no longer matches');
    }
    const assignmentEdited = assignmentChanges.length > 0;
    const protectedTask = isProtected(task);
    const routingInput = statusChanges.length > 0 || fieldChanges.some(change =>
      ['effort estimate', 'assigned sprint'].includes(normalize(change.custom_field.name)));
    const detailsOnly = this.sprintTasks && !assignmentEdited &&
      (protectedTask || (changes.length > 0 && !routingInput));
    if (protectedTask && !detailsOnly && !(assignmentEdited && isBlank(assigned.value))) {
      return skip('Testing or later workflow status is protected');
    }
    if (!assigned?.id || assigned.type !== 'short_text') {
      throw new Error('Assigned Sprint must be an accessible short_text custom field');
    }
    const currentStatus = statusName(task.status);
    if (!protectedTask && !detailsOnly && !sprintOffsets.has(currentStatus) && !backlogStatuses.has(currentStatus)) {
      throw new Error(`Unrecognized task status "${currentStatus}"; refusing to move it`);
    }
    if (!isBlank(assigned.value) && typeof assigned.value !== 'string') {
      throw new Error('Assigned Sprint contains a non-text value');
    }
    if (detailsOnly) {
      catalog = catalog || await this.loadCatalog();
      const sprint = isBlank(assigned.value) ? null :
        catalog.sprints.find(item => item.name.trim() === assigned.value.trim());
      if (!sprint && !isBlank(assigned.value)) {
        throw new Error(`Assigned Sprint "${assigned.value}" was not found in the Sprint Folder`);
      }
      let sprintTask = await this.sprintTasks.prepare(task, sprint, catalog, { allowCreate: false });
      if (!dryRun) sprintTask = await this.sprintTasks.apply(sprintTask, catalog);
      return {
        taskId: task.id, outcome: sprintTask.changed ? (dryRun ? 'planned' : 'updated') : 'unchanged',
        targetStatus: currentStatus, assignedSprint: sprint?.name ?? null, updates: {}, assignment: null, sprintTask
      };
    }

    catalog = catalog || await this.loadCatalog();
    const now = this.now();
    const requestedStatus = !assignmentEdited && matchingStatusChange ?
      statusName(matchingStatusChange.after) : null;
    const unscheduling = requestedStatus === 'ready to schedule';
    let sprint = unscheduling || isBlank(assigned.value) ? null :
      catalog.sprints.find(item => item.name.trim() === assigned.value.trim());
    const scheduling = sprintOffsets.has(requestedStatus);
    if (!sprint && !isBlank(assigned.value) && !scheduling && !unscheduling) {
      throw new Error(`Assigned Sprint "${assigned.value}" was not found in the Sprint Folder`);
    }
    const existingStatus = sprint ? assignedSprintStatus(sprint, catalog, now) : 'ready to schedule';

    // A status produced by reconciliation is not another scheduling instruction.
    if (scheduling && requestedStatus !== existingStatus) {
      const targetIndex = currentSprintIndex(catalog, now) + sprintOffsets.get(requestedStatus);
      sprint = catalog.active[targetIndex];
      if (!sprint) throw new Error(`No sprint exists for ${requestedStatus.toUpperCase()}`);
    }

    const targetStatus = protectedTask ? currentStatus :
      (sprint ? assignedSprintStatus(sprint, catalog, now) : 'ready to schedule');
    if (!catalog.statuses.includes(targetStatus)) {
      throw new Error(`Master Backlog does not have status "${targetStatus}"`);
    }
    const updates = {};
    if (currentStatus !== targetStatus) updates.status = targetStatus;
    for (const [key, value] of [['start_date', sprint?.start ?? null], ['due_date', sprint?.end ?? null]]) {
      if (value === null ? task[key] != null : Number(task[key]) !== value || task[key] == null) {
        updates[key] = value;
        // Without time flags, ClickUp normalizes task dates to 4 a.m. locally.
        if (value !== null) updates[`${key}_time`] = true;
      }
    }
    const assignment = unscheduling && !isBlank(assigned.value) ?
      { fieldId: assigned.id, value: null } :
      sprint && assigned.value !== sprint.name ? { fieldId: assigned.id, value: sprint.name } : null;
    const sprintTask = this.sprintTasks ?
      await this.sprintTasks.prepare(task, sprint, catalog, {
        allowCreate: Boolean(sprint && !protectedTask && !sprint.archived && !sprint.completed)
      }) : null;
    const changed = assignment !== null || Object.keys(updates).length > 0 || sprintTask?.changed === true;
    const plan = {
      taskId: task.id, outcome: changed ? (dryRun ? 'planned' : 'updated') : 'unchanged',
      targetStatus, assignedSprint: sprint?.name ?? null, updates, assignment, sprintTask
    };
    if (!changed || dryRun) return plan;

    if (assignment) {
      if (assignment.value === null) await this.clickup.clearCustomFieldValue(task.id, assignment.fieldId);
      else await this.clickup.setCustomFieldValue(task.id, assignment.fieldId, assignment.value);
      assigned.value = assignment.value;
    }
    if (Object.keys(updates).length > 0) {
      await this.clickup.updateTask(task.id, updates);
      if (updates.status) task.status.status = updates.status;
      for (const key of ['start_date', 'due_date']) {
        if (Object.hasOwn(updates, key)) task[key] = updates[key];
      }
    }
    if (sprintTask) plan.sprintTask = await this.sprintTasks.apply(sprintTask, catalog);
    logger.info(`Task ${task.id}: sprint routing -> ${targetStatus.toUpperCase()}`, {
      assignedSprint: plan.assignedSprint
    });
    return plan;
  }

  async reconcileBacklog({ dryRun = false } = {}) {
    const catalog = await this.loadCatalog();
    const tasks = await this.clickup.getListTasks(this.config.backlogListId);
    const plans = [];
    const errors = [];
    for (const task of tasks) {
      if (!this.isEligible(task) || (isProtected(task) && !this.sprintTasks)) continue;
      try {
        const plan = await this.withTaskLock(task.id, async () =>
          this.reconcileTask(await this.clickup.getTask(task.id), { catalog, dryRun }));
        plans.push(plan);
      } catch (error) {
        logger.error(`Sprint reconciliation failed for task ${task.id}:`, error.message);
        errors.push(new Error(`Task ${task.id}: ${error.message}`));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Sprint reconciliation failed for ${errors.length} task(s)`);
    }
    return { dryRun, scanned: tasks.length, evaluated: plans.length, plans };
  }
}

module.exports = { SprintRouting, buildCatalog };
