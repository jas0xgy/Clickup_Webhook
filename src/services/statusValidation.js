const { logger } = require('../utils/logger');

const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function hasValue(field) {
  if (!field || field.value == null) return false;
  if (typeof field.value === 'string') return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  if (typeof field.value === 'object') return Object.keys(field.value).length > 0;
  return true;
}

class StatusValidation {
  constructor(validations) {
    this.validations = validations;
  }

  validationsFor(change, task) {
    if (change?.field !== 'status' || typeof change.after?.status !== 'string') return [];
    return this.validations.filter(validation =>
      validation.enabled !== false &&
      normalize(validation.status) === normalize(change.after.status) &&
      (!task || String(task.list?.id) === String(validation.listId))
    );
  }

  matchesChange(change) {
    return this.validationsFor(change).length > 0;
  }

  async run(task, changes, clickup) {
    for (const change of changes) {
      const validations = this.validationsFor(change, task);
      if (validations.length === 0) continue;
      const status = validations[0].status;
      const names = validations.map(validation => validation.name).join(', ');
      if (normalize(task.status?.status) !== normalize(status)) {
        logger.debug(`Task ${task.id}: status changed again; skipping "${names}"`);
        continue;
      }

      const previousStatus = change.before?.status;
      if (typeof previousStatus !== 'string' || !previousStatus.trim()) {
        throw new Error(`Cannot run "${names}": webhook history has no previous status`);
      }
      if (normalize(previousStatus) === normalize(status)) continue;

      const requiredFields = [...new Set(validations.flatMap(validation => validation.requiredFields))];
      const missingFields = requiredFields.filter(fieldName => !hasValue(clickup.getCustomField(task, fieldName)));
      if (missingFields.length === 0) {
        if (validations.some(validation => normalize(validation.appendTaskIdFromStatus) === normalize(previousStatus))) {
          await appendTaskId(clickup, task);
        }
        continue;
      }

      const previous = previousStatus.trim();
      const comment = [
        { text: `[Workflow Agent] Validation failed for ${status.toUpperCase()}. Required fields are missing or empty: ` },
        ...missingFields.flatMap((name, index) => [
          ...(index > 0 ? [{ text: ', ' }] : []),
          { text: name.toUpperCase(), attributes: { bold: true, italic: true } }
        ]),
        { text: `. The task was returned to "${previous}".` }
      ];
      await clickup.updateTaskStatus(task.id, previous);
      await clickup.addTaskComment(task.id, comment);
      logger.info(`Task ${task.id}: "${names}" failed; missing ${missingFields.join(', ')}`);
      return {
        outcome: 'failed',
        reason: `missing required fields: ${missingFields.join(', ')}`,
        stopProcessing: true
      };
    }

    return { outcome: 'passed' };
  }
}

async function appendTaskId(clickup, task) {
  const suffix = `[id: ${task.id}]`;
  if (task.name.includes(suffix)) return;

  const name = `${task.name.trimEnd()} ${suffix}`;
  await clickup.updateTask(task.id, { name });
  task.name = name;
  logger.info(`Task ${task.id}: appended task ID to title`);
}

module.exports = { StatusValidation };
