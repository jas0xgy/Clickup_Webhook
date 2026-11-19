const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');
const { sourceIdOf } = require('./sprintTasks');
const { planUserStory } = require('./userStory');

const status = task => task.status?.status?.trim().toLowerCase();
const home = (task, listId) => String(task.list?.id) === String(listId);
const terminal = task => ['deployed', 'complete'].includes(status(task)) ||
  ['done', 'closed'].includes(task.status?.type);

async function validateWorkflow(clickup, config, now = Date.now()) {
  const { backlogListId, sprintFolderId, sprintTasks, estimation, acceptanceTesting, workflowValidation } = config;
  const [backlog, sprints, archivedSprints] = await Promise.all([
    clickup.getListTasks(backlogListId),
    clickup.getFolderLists(sprintFolderId, false),
    clickup.getFolderLists(sprintFolderId, true)
  ]);
  const sprintLists = new Map([...sprints, ...archivedSprints].map(list => [String(list.id), list]));
  const activeSprintIds = new Set(sprints.filter(list => !list.archived &&
    !config.completedSprintIds.includes(String(list.id))).map(list => String(list.id)));
  const lists = [
    ...(estimation?.enabled ? [[estimation.listId, 'estimation']] : []),
    ...(acceptanceTesting?.enabled ? [[acceptanceTesting.listId, 'testing']] : []),
    ...(sprintTasks?.enabled ? [...sprintLists.keys()].map(id => [id, 'sprint']) : [])
  ];
  const copies = new Map();
  // Read lists serially to limit bursts against ClickUp's per-token rate limit.
  for (const [id, kind] of lists) {
    for (const item of await clickup.getListTasks(id)) {
      if (item.archived || !home(item, id)) continue;
      const task = typeof item.description === 'string' || typeof item.text_content === 'string' ?
        item : await clickup.getTask(item.id);
      if (task.archived || !home(task, id)) continue;
      const sourceId = sourceIdOf(task);
      if (!sourceId) continue;
      if (!copies.has(sourceId)) copies.set(sourceId, { estimation: [], testing: [], sprint: [] });
      copies.get(sourceId)[kind].push(task);
    }
  }

  const findings = [];
  let scanned = 0;
  const cutoff = now - workflowValidation.recentDays * 86400000;
  for (const task of backlog) {
    if (task.archived || !home(task, backlogListId) || (terminal(task) && !(Number(task.date_updated) >= cutoff))) continue;
    scanned++;
    const report = (issue, details = {}) => findings.push({ taskId: task.id, issue, ...details });
    const currentStatus = status(task);
    const story = planUserStory(clickup, task);
    if (story.issue && (story.issue !== 'incomplete-story-inputs' || currentStatus !== 'new backlog')) {
      report(story.issue, story.fields ? { fields: story.fields } : {});
    }

    const related = copies.get(task.id) || { estimation: [], testing: [], sprint: [] };
    for (const [kind, items] of Object.entries(related)) {
      if (items.length > 1) report('duplicate-active-copies', { kind, copyIds: items.map(item => item.id) });
    }
    if (estimation?.enabled) {
      if (currentStatus === estimation.triggerStatus && !related.estimation.length) report('missing-estimation-copy');
      if (estimation.archiveOnStatuses.includes(currentStatus) && related.estimation.length) {
        report('estimation-copy-still-active');
      }
      const ready = related.estimation.find(item => status(item) === estimation.readyStatus);
      const estimate = ready && numberValue(clickup.getCustomField(ready, estimation.estimateField)?.value);
      if (ready && currentStatus === estimation.triggerStatus && !(estimate > 0)) report('estimate-ready-without-effort');
      if (ready && currentStatus === estimation.triggerStatus && estimate > 0 &&
          numberValue(clickup.getCustomField(task, estimation.estimateField)?.value) !== estimate) {
        report('estimate-not-applied-to-backlog');
      }
    }
    if (acceptanceTesting?.enabled) {
      if ([acceptanceTesting.backlogStatus, acceptanceTesting.backlogCompleteStatus].includes(currentStatus) &&
          !related.testing.length) report('missing-testing-copy');
      if (currentStatus === acceptanceTesting.backlogStatus &&
          related.testing.some(item => status(item) === acceptanceTesting.completeStatus)) report('testing-completion-not-applied');
      if (acceptanceTesting.archiveOnStatuses.includes(currentStatus) && related.testing.length) {
        report('testing-copy-still-active');
      }
      const ready = related.sprint.some(item => {
        const checked = clickup.getCustomField(item, acceptanceTesting.checkboxField)?.value;
        return (checked === true || checked === 'true') &&
          activeSprintIds.has(String(item.list.id)) &&
          ![acceptanceTesting.backlogStatus, acceptanceTesting.backlogCompleteStatus,
            ...acceptanceTesting.archiveOnStatuses].includes(currentStatus) && !terminal(task);
      });
      if (ready) report('testing-handoff-not-applied');
    }
    if (sprintTasks?.enabled && ['sprint 0', 'sprint +1', 'sprint +2'].includes(currentStatus)) {
      const assigned = clickup.getCustomField(task, 'Assigned Sprint')?.value;
      const expected = [...sprintLists.values()].find(list => list.name === assigned);
      if (!expected) report('scheduled-without-valid-sprint');
      else if (!related.sprint.some(item => home(item, expected.id))) {
        report(related.sprint.length ? 'sprint-copy-in-wrong-list' : 'missing-sprint-copy', { listId: expected.id });
      }
    }
  }
  return { scanned, findings };
}

function startWorkflowValidation(clickup, config) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const { scanned, findings } = await validateWorkflow(clickup, config);
      logger.info('Workflow validation finished (report only)', { scanned, findings: findings.length });
      for (const finding of findings) logger.warn('Workflow validation finding', JSON.stringify(finding));
    } catch (error) {
      logger.error('Workflow validation failed:', error.message);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(run, config.workflowValidation.intervalMinutes * 60000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

module.exports = { validateWorkflow, startWorkflowValidation };
