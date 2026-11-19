const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sprintRouting: config } = require('../src/config');
const { ClickUpClient } = require('../src/services/clickupClient');
const { planUserStory } = require('../src/services/userStory');
const { validateWorkflow } = require('../src/services/workflowValidation');

const clientFields = {
  getCustomField: ClickUpClient.prototype.getCustomField,
  getDropdownOption: ClickUpClient.prototype.getDropdownOption
};
const fields = ['Persona', 'Goal', 'Benefit', 'Success'].map(name =>
  ({ name, id: name, type: 'short_text', value: name }));

test('story updates replace only the managed section and are idempotent', () => {
  const description = 'Notes\n\nUser Story (managed)\nOld story\nEnd User Story (managed)\n\nLinks';
  const markdown_description = '**Notes**\n\nUser Story (managed)\n\nOld story\n\nEnd User Story (managed)\n\n[Links](https://example.com)';
  const plan = planUserStory(clientFields, { description, markdown_description, custom_fields: fields });
  assert.equal(plan.updates.markdown_description,
    '**Notes**\n\nUser Story (managed)\n\nPersona Goal Benefit.\n\nSuccess is when Success.\n\nEnd User Story (managed)\n\n[Links](https://example.com)');
  assert.deepEqual(planUserStory(clientFields, {
    description: plan.next, ...plan.updates, custom_fields: fields
  }), {});
  assert.equal(planUserStory(clientFields, { description: 'User Story (managed)', custom_fields: fields }).issue,
    'ambiguous-story-section');
});

test('report-only scan finds missed stories on recent deployed items and detects copy drift', async () => {
  const now = Date.parse('2026-11-19T21:00:00Z');
  const backlog = (id, status, extra) => ({
    id, list: { id: config.backlogListId }, status: { status }, ...extra
  });
  const copy = (id, listId, sourceId, status) => ({
    id, list: { id: listId }, status: { status }, description: `Backlog task: https://app.clickup.com/t/${sourceId}`
  });
  const lists = new Map([
    [config.backlogListId, [
      backlog('deployed', 'deployed', { date_updated: String(now - 60000), custom_fields: fields, description: '' }),
      backlog('old', 'deployed', { date_updated: String(now - 8 * 86400000), custom_fields: fields }),
      backlog('queued', 'awaiting estimation'),
      backlog('testing', 'in testing')
    ]],
    [config.acceptanceTesting.listId, ['test-a', 'test-b'].map(id =>
      copy(id, config.acceptanceTesting.listId, 'testing', 'test complete'))]
  ]);
  const result = await validateWorkflow({
    ...clientFields,
    getFolderLists: async () => [],
    getListTasks: async id => lists.get(id) || []
  }, config, now);
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.findings, [
    { taskId: 'deployed', issue: 'missing-story-section' },
    { taskId: 'queued', issue: 'missing-estimation-copy' },
    { taskId: 'testing', issue: 'duplicate-active-copies', kind: 'testing', copyIds: ['test-a', 'test-b'] },
    { taskId: 'testing', issue: 'testing-completion-not-applied' }
  ]);
});
