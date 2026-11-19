const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');
const { sprintRouting: sprintConfig } = require('../config');
const { archiveCopiesOnStatus } = require('./managedCopies');
const { storyFields, ensureUserStory } = require('./userStory');

function statusChangedTo(change, settings, key) {
  return Boolean(settings?.enabled && settings[key]) && change?.field === 'status' &&
    typeof change.after?.status === 'string' &&
    change.after.status.trim().toLowerCase() === settings[key].toLowerCase();
}

function statusChangedToAny(change, settings) {
  return Boolean(settings?.enabled && Array.isArray(settings.archiveOnStatuses)) &&
    change?.field === 'status' && typeof change.after?.status === 'string' &&
    settings.archiveOnStatuses.some(status => status.toLowerCase() === change.after.status.trim().toLowerCase());
}

function createDropdownNumberRule({ name, sourceField, targetField, values }) {
  return {
    name,
    sourceField,
    matchesChange: () => true,
    async run({ task, field, clickup }) {
      const target = clickup.getCustomField(task, targetField);
      if (field.type !== 'drop_down' || !target?.id || target.type !== 'number') {
        throw new Error(`Expected dropdown "${sourceField}" and numeric field "${targetField}"`);
      }

      if (field.value == null || field.value === '') {
        if (target.value != null && target.value !== '') {
          await clickup.clearCustomFieldValue(task.id, target.id);
          delete target.value;
          logger.info(`Task ${task.id}: cleared ${targetField} because ${sourceField} was cleared`);
        }
        return;
      }

      const option = clickup.getDropdownOption(field);
      if (!option || !Object.hasOwn(values, option.name)) {
        throw new Error(`No ${targetField} mapping for ${sourceField} option "${option?.name || field.value}"`);
      }
      const value = values[option.name];
      if (!Number.isFinite(value)) {
        throw new Error(`Mapping for "${option.name}" must be a finite number`);
      }
      if (target.value != null && target.value !== '' && numberValue(target.value) === value) {
        logger.debug(`Task ${task.id}: ${targetField} is already ${value}`);
        return;
      }

      await clickup.setCustomFieldValue(task.id, target.id, value);
      target.value = value;
      logger.info(`Task ${task.id}: set ${targetField} to ${value} for ${sourceField} "${option.name}"`);
    }
  };
}

const automationRules = [
  {
    name: 'custom-fields-to-task-description',
    matchesChange: change => change?.field === 'custom_field' && typeof change.custom_field?.id === 'string' &&
      storyFields.some(name =>
        typeof change.custom_field?.name === 'string' &&
        change.custom_field.name.trim().toLowerCase() === name.toLowerCase()),
    run({ task, clickup, changes }) {
      if (!changes.some(({ custom_field: field }) => clickup.getCustomField(task, field.name)?.id === field.id)) {
        logger.warn(`Task ${task.id}: story event has no matching current source field`);
        return { outcome: 'skipped', reason: 'no matching current source field' };
      }
      return ensureUserStory(clickup, task, sprintConfig.backlogListId);
    }
  },
  {
    name: 'sprint-routing',
    matchesChange: change => change?.field === 'status' || change?.field === 'name' ||
      (change?.field === 'custom_field' && typeof change.custom_field?.id === 'string' &&
        typeof change.custom_field.name === 'string' &&
        ['effort estimate', 'assigned sprint', 'product'].includes(change.custom_field.name.trim().toLowerCase())),
    run: ({ task, changes, sprintRouting }) => sprintRouting.reconcileTask(task, { changes })
  },
  {
    name: 'ready-for-acceptance-testing',
    matchesChange: change => {
      const settings = sprintConfig.acceptanceTesting;
      return Boolean(settings?.enabled) && change?.field === 'custom_field' &&
        typeof change.custom_field?.name === 'string' &&
        change.custom_field.name.trim().toLowerCase() === settings.checkboxField.toLowerCase() &&
        (change.after === true || change.after === 'true');
    },
    run: ({ task, acceptanceTesting }) => acceptanceTesting.handle(task)
  },
  {
    name: 'testing-complete-to-ready-to-deploy',
    matchesChange: change => statusChangedTo(change, sprintConfig.acceptanceTesting, 'completeStatus'),
    run: ({ task, acceptanceTesting }) => acceptanceTesting.complete(task)
  },
  {
    name: 'awaiting-estimation-to-estimation-list',
    matchesChange: change => statusChangedTo(change, sprintConfig.estimation, 'triggerStatus'),
    run: ({ task, estimation }) => estimation.request(task)
  },
  {
    name: 'estimate-ready-to-backlog-estimate',
    matchesChange: change => statusChangedTo(change, sprintConfig.estimation, 'readyStatus'),
    run: ({ task, estimation }) => estimation.complete(task)
  },
  {
    name: 'scheduled-archives-estimation-copy',
    matchesChange: change => statusChangedToAny(change, sprintConfig.estimation),
    run: ({ task, clickup }) => archiveCopiesOnStatus({
      clickup, config: sprintConfig, task, settings: sprintConfig.estimation, label: 'estimation'
    })
  },
  {
    name: 'deployed-archives-testing-copy',
    matchesChange: change => statusChangedToAny(change, sprintConfig.acceptanceTesting),
    run: ({ task, clickup }) => archiveCopiesOnStatus({
      clickup, config: sprintConfig, task, settings: sprintConfig.acceptanceTesting, label: 'testing'
    })
  },
  createDropdownNumberRule({
    name: 'backlog-priority-to-business-value',
    sourceField: 'Backlog Priority',
    targetField: 'Business Value',
    values: {
      'Critical (Blocker, No work around)': 10,
      'Must Have': 7,
      'Workaround Exists': 5,
      'Nice to Have': 3,
      'Minor Impact': 2
    }
  })
];

module.exports = { automationRules };
