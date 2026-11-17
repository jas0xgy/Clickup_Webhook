const { logger } = require('../utils/logger');
const { numberValue } = require('../utils/fields');

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
    name: 'sprint-routing',
    matchesChange: change => change?.field === 'status' || change?.field === 'name' ||
      (change?.field === 'custom_field' && typeof change.custom_field?.id === 'string' &&
        typeof change.custom_field.name === 'string' &&
        ['effort estimate', 'assigned sprint', 'product', 'persona'].includes(change.custom_field.name.trim().toLowerCase())),
    run: ({ task, changes, sprintRouting }) => sprintRouting.reconcileTask(task, { changes })
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
