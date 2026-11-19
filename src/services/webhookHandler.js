const { ClickUpClient } = require('./clickupClient');
const { automationRules } = require('./automationRules');
const { SprintRouting } = require('./sprintRouting');
const { AcceptanceTesting } = require('./acceptanceTesting');
const { Estimation } = require('./estimation');
const { SprintCreation } = require('./sprintCreation');
const { sprintRouting: sprintConfig } = require('../config');
const { logger } = require('../utils/logger');

const clickup = new ClickUpClient();
const sprintRouting = new SprintRouting(clickup, sprintConfig);
const acceptanceTesting = new AcceptanceTesting(clickup, sprintConfig, sprintRouting);
const estimation = new Estimation(clickup, sprintConfig, sprintRouting);
const sprintCreation = new SprintCreation(clickup, sprintConfig, sprintRouting);

/**
 * Handles incoming webhook events from ClickUp
 * @param {Object} event - The webhook event object
 */
async function handleWebhook(event) {
  const eventType = event.event;

  logger.debug('Processing webhook event:', JSON.stringify(event, null, 2));

  try {
    switch (eventType) {
      case 'taskUpdated':
      case 'taskStatusUpdated':
        await handleTaskUpdated(event);
        break;
      case 'taskCommentAdded':
        await handleTaskCommentAdded(event);
        break;
      case 'listUpdated':
        await handleListUpdated(event);
        break;
      default:
        logger.info(`Unhandled event type: ${eventType}`);
    }
  } catch (error) {
    logger.error('Error in webhook handler:', error.message);
  }
}

function describeChange(change) {
  const value = side => side?.status ?? side?.name ?? (typeof side === 'object' ? undefined : side);
  return {
    field: change?.custom_field?.name || change?.field,
    before: value(change?.before), after: value(change?.after)
  };
}

function ruleOutcome(result) {
  if (result && typeof result === 'object') {
    return { outcome: result.outcome || 'done', ...(result.reason ? { reason: result.reason } : {}) };
  }
  return { outcome: 'done' };
}

async function handleTaskUpdated(event) {
  logger.info('Task updated event received');

  if (!event.task_id || !Array.isArray(event.history_items)) {
    logger.warn('Task update is missing task_id or history_items');
    return;
  }

  const audit = {
    event: event.event, taskId: event.task_id, webhookId: event.webhook_id,
    user: event.history_items[0]?.user?.username,
    changes: event.history_items.map(describeChange), rules: []
  };
  try {
    await runMatchingRules(event, audit);
  } catch (error) {
    audit.error = error.message;
    throw error;
  } finally {
    logger.audit(audit);
  }
}

async function runMatchingRules(event, audit) {
  const matchingRules = automationRules.map(rule => ({
    rule,
    changes: event.history_items.filter(change =>
      (!rule.sourceField || (change?.field === 'custom_field' &&
        typeof change.custom_field?.name === 'string' &&
        typeof change.custom_field.id === 'string' &&
        change.custom_field.id !== '' &&
        change.custom_field.name.trim().toUpperCase() === rule.sourceField.trim().toUpperCase())) &&
      rule.matchesChange(change)
    )
  })).filter(({ changes }) => changes.length > 0);
  if (matchingRules.length === 0) {
    logger.debug(`Task ${event.task_id}: no matching automation rules`);
    return;
  }

  await sprintRouting.withTaskLock(event.task_id, async () => {
    const task = await clickup.getTask(event.task_id);
    for (const { rule, changes } of matchingRules) {
      const field = rule.sourceField ? clickup.getCustomField(task, rule.sourceField) : null;
      if (rule.sourceField && (!field || !changes.some(change => change.custom_field.id === field.id))) {
        logger.warn(`Task ${event.task_id}: rule "${rule.name}" has no matching current source field`);
        audit.rules.push({ rule: rule.name, outcome: 'skipped', reason: 'no matching current source field' });
        continue;
      }
      try {
        const result = await rule.run({ task, field, changes, clickup, sprintRouting, acceptanceTesting, estimation });
        audit.rules.push({ rule: rule.name, ...ruleOutcome(result) });
      } catch (error) {
        logger.error(`Task ${event.task_id}: automation "${rule.name}" failed:`, error.message);
        audit.rules.push({ rule: rule.name, outcome: 'failed', error: error.message });
      }
    }
  });
}

/**
 * Handles when a comment is added to a task
 */
async function handleTaskCommentAdded(event) {
  logger.info('Task comment added event received');

  const taskId = event.task_id;
  const comment = event.webhook_data?.comment;

  logger.info(`Comment added to task ${taskId}: ${comment}`);

  // Add your custom logic here if needed
}

/**
 * Handles when a list is updated
 */
async function handleListUpdated(event) {
  logger.info('List updated event received');

  const listId = event.list_id;

  logger.info(`List ${listId} was updated`);

  // Add your custom logic here if needed
}

module.exports = {
  handleWebhook,
  reconcileSprints: async options => {
    let sprints;
    try {
      sprints = await sprintCreation.ensureFutureSprints(options);
    } catch (error) {
      logger.error('Sprint creation failed:', error.message);
      sprints = { dryRun: Boolean(options?.dryRun), planned: [], created: [], error: error.message };
    }
    const result = await sprintRouting.reconcileBacklog(options);
    return { ...result, sprintCreation: sprints };
  }
};
