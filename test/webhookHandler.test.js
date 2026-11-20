const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClickUpClient } = require('../src/services/clickupClient');
const { handleWebhook } = require('../src/services/webhookHandler');
const { SprintRouting } = require('../src/services/sprintRouting');
const { Estimation } = require('../src/services/estimation');
const { AcceptanceTesting } = require('../src/services/acceptanceTesting');
const { sprintRouting } = require('../src/config');

const fieldId = 'estimate-field-id';

function eventFor(before, after) {
  return {
    event: 'taskUpdated',
    task_id: 'test-task',
    history_items: [{
      field: 'custom_field',
      custom_field: { id: fieldId, name: 'Effort Estimate', type: 'number' },
      before,
      after
    }]
  };
}

const requiredStatusFields = [
  'Product', 'Platform', 'Item Type', 'Persona', 'Goal', 'Benefit', 'Success', 'Backlog Priority'
];

function awaitingEstimationTask(values = {}) {
  return {
    id: 'test-task',
    name: 'PPI Reason Selection',
    list: { id: sprintRouting.backlogListId },
    status: { status: 'AWAITING ESTIMATION' },
    custom_fields: requiredStatusFields.map(name => ({
      id: name.toLowerCase().replaceAll(' ', '-'),
      name,
      value: Object.hasOwn(values, name) ? values[name] : 'filled'
    }))
  };
}

function awaitingEstimationEvent(before = 'new backlog', event = 'taskUpdated') {
  return {
    event,
    task_id: 'test-task',
    history_items: [{
      field: 'status',
      before: { status: before },
      after: { status: 'AWAITING ESTIMATION' }
    }]
  };
}

test('invalid Awaiting Estimation moves are reverted and commented with missing fields', async t => {
  const task = awaitingEstimationTask({ Product: '', Goal: '  ', 'Backlog Priority': null });
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const rename = t.mock.method(ClickUpClient.prototype, 'updateTask', async () => ({}));
  const updateStatus = t.mock.method(ClickUpClient.prototype, 'updateTaskStatus', async (id, status) => {
    task.status.status = status;
  });
  const comment = t.mock.method(ClickUpClient.prototype, 'addTaskComment', async () => ({}));
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const request = t.mock.method(Estimation.prototype, 'request', async () => ({}));

  await handleWebhook(awaitingEstimationEvent('new backlog', 'taskStatusUpdated'));

  assert.deepEqual(updateStatus.mock.calls.map(call => call.arguments), [['test-task', 'new backlog']]);
  assert.deepEqual(comment.mock.calls.map(call => call.arguments), [[task.id, [
    { text: '[Workflow Agent] Validation failed for AWAITING ESTIMATION. Required fields are missing or empty: ' },
    { text: 'PRODUCT', attributes: { bold: true, italic: true } },
    { text: ', ' },
    { text: 'GOAL', attributes: { bold: true, italic: true } },
    { text: ', ' },
    { text: 'BACKLOG PRIORITY', attributes: { bold: true, italic: true } },
    { text: '. The task was returned to "new backlog".' }
  ]]]);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(route.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

test('a valid New Backlog move appends the ID once before the estimation handoff', async t => {
  const task = awaitingEstimationTask();
  const expectedName = 'PPI Reason Selection [id: test-task]';
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => ({ ...task }));
  const rename = t.mock.method(ClickUpClient.prototype, 'updateTask', async (_id, { name }) => {
    task.name = name;
  });
  const updateStatus = t.mock.method(ClickUpClient.prototype, 'updateTaskStatus', async () => ({}));
  const comment = t.mock.method(ClickUpClient.prototype, 'addTaskComment', async () => ({}));
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const request = t.mock.method(Estimation.prototype, 'request', async () => ({}));

  await handleWebhook(awaitingEstimationEvent(' NEW BACKLOG '));
  await handleWebhook(awaitingEstimationEvent('new backlog', 'taskStatusUpdated'));

  assert.deepEqual(rename.mock.calls.map(call => call.arguments), [[task.id, { name: expectedName }]]);
  assert.equal(updateStatus.mock.callCount(), 0);
  assert.equal(comment.mock.callCount(), 0);
  assert.equal(route.mock.callCount(), 2);
  assert.deepEqual(request.mock.calls.map(call => call.arguments[0].name), [expectedName, expectedName]);
});

test('an Awaiting Estimation move from a different status does not rename the task', async t => {
  const task = awaitingEstimationTask();
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const rename = t.mock.method(ClickUpClient.prototype, 'updateTask', async () => ({}));
  t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const request = t.mock.method(Estimation.prototype, 'request', async () => ({}));

  await handleWebhook(awaitingEstimationEvent('ready to schedule'));

  assert.equal(rename.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 1);
});

test('status validation is scoped to the configured Master Backlog List', async t => {
  const task = awaitingEstimationTask({ Product: null });
  task.list.id = 'another-list';
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const updateStatus = t.mock.method(ClickUpClient.prototype, 'updateTaskStatus', async () => ({}));
  const comment = t.mock.method(ClickUpClient.prototype, 'addTaskComment', async () => ({}));

  await handleWebhook(awaitingEstimationEvent());

  assert.equal(updateStatus.mock.callCount(), 0);
  assert.equal(comment.mock.callCount(), 0);
});

test('estimate and both status webhook types dispatch to the shared sprint rule', async t => {
  const task = { id: 'test-task' };
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  await handleWebhook(eventFor(0, 3));
  for (const event of ['taskUpdated', 'taskStatusUpdated']) {
    await handleWebhook({
      event, task_id: 'test-task',
      history_items: [{ field: 'status', before: { status: 'new backlog' }, after: { status: 'sprint +1' } }]
    });
  }
  assert.equal(get.mock.callCount(), 3);
  assert.equal(route.mock.callCount(), 3);
  assert.equal(route.mock.calls[0].arguments[0], task);
  assert.equal(route.mock.calls[2].arguments[1].changes[0].field, 'status');
});

test('a Return to Development status webhook dispatches the acceptance testing return', async t => {
  const task = { id: 'testing-task', list: { id: sprintRouting.acceptanceTesting.listId } };
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const returnToDevelopment = t.mock.method(AcceptanceTesting.prototype, 'returnToDevelopment', async () => ({}));

  await handleWebhook({
    event: 'taskUpdated', task_id: task.id,
    history_items: [{ field: 'status', before: { status: 'test in progress' }, after: { status: 'Return to Development' } }]
  });

  assert.deepEqual(returnToDevelopment.mock.calls.map(call => call.arguments), [[task]]);
});

test('unrelated fields and formula updates do not fetch tasks or trigger routing', async t => {
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => ({}));
  for (const name of ['Approval', 'Value/Effort Score']) {
    const event = eventFor(null, 3);
    event.history_items[0].custom_field.name = name;
    await handleWebhook(event);
  }
  assert.equal(get.mock.callCount(), 0);
});

test('only an Awaiting Estimation reset deletes the matching estimation copy', async t => {
  const task = {
    id: 'backlog-source', list: { id: sprintRouting.backlogListId },
    status: { status: 'new backlog' }, linked_tasks: []
  };
  const list = { id: sprintRouting.estimation.listId };
  const description = `Backlog task: https://app.clickup.com/t/${task.id}`;
  const copies = new Map([
    ['manual', { id: 'manual', list, description: '' }],
    ['testing', { id: 'testing', list: { id: 'another-list' }, description }],
    ['estimate', { id: 'estimate', list, description }]
  ]);
  task.linked_tasks.push({ task_id: task.id, link_id: 'testing' });
  t.mock.method(ClickUpClient.prototype, 'getTask', async id => id === task.id ? task : copies.get(id));
  t.mock.method(ClickUpClient.prototype, 'getListTasks', async () => [...copies.values()]);
  t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const remove = t.mock.method(ClickUpClient.prototype, 'deleteTask', async id => copies.delete(id));
  const update = t.mock.method(ClickUpClient.prototype, 'updateTask', async () => ({}));
  const reset = (before, event = 'taskStatusUpdated') => handleWebhook({
    event, task_id: task.id,
    history_items: [{ field: 'status', before: { status: before }, after: { status: 'NEW BACKLOG' } }]
  });

  await reset('ready to schedule');
  await reset(undefined);
  task.status.status = 'ready to schedule';
  await reset('awaiting estimation');
  task.status.status = 'new backlog';
  task.list = list;
  await reset('awaiting estimation');
  assert.equal(remove.mock.callCount(), 0);

  task.list = { id: sprintRouting.backlogListId };
  await reset(' AWAITING ESTIMATION ');
  await reset('awaiting estimation', 'taskUpdated');
  assert.deepEqual(remove.mock.calls.map(call => call.arguments), [['estimate']]);
  assert.deepEqual([...copies.keys()], ['manual', 'testing']);
  assert.equal(update.mock.callCount(), 0);
});

test('task name and Product changes dispatch to sprint routing while Persona only updates the description', async t => {
  const task = {
    id: 'test-task',
    list: { id: sprintRouting.backlogListId },
    custom_fields: ['Persona', 'Goal', 'Benefit', 'Success'].map(name => ({
      id: name.toLowerCase(), name, type: 'short_text', value: name
    }))
  };
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const update = t.mock.method(ClickUpClient.prototype, 'updateTask', async () => ({}));
  for (const change of [
    { field: 'name', before: 'Old', after: 'New' },
    { field: 'custom_field', custom_field: { id: 'product', name: 'Product' }, after: 0 },
    { field: 'custom_field', custom_field: { id: 'persona', name: 'Persona' }, after: null }
  ]) {
    await handleWebhook({ event: 'taskUpdated', task_id: 'test-task', history_items: [change] });
  }
  assert.equal(get.mock.callCount(), 3);
  assert.equal(route.mock.callCount(), 2);
  assert.equal(update.mock.callCount(), 1);
});

test('changes to any description input rebuild the task description from current field values', async t => {
  const task = {
    id: 'test-task',
    list: { id: sprintRouting.backlogListId },
    custom_fields: [
      {
        id: 'persona', name: 'Persona', type: 'drop_down', value: 'user-option',
        type_config: { options: [{ id: 'user-option', name: 'End user' }] }
      },
      { id: 'goal', name: 'Goal', type: 'short_text', value: 'reduce setup time' },
      { id: 'benefit', name: 'Benefit', type: 'short_text', value: 'faster onboarding' },
      { id: 'success', name: 'Success', type: 'short_text', value: 'users finish setup in minutes' }
    ]
  };
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const update = t.mock.method(ClickUpClient.prototype, 'updateTask', async (taskId, updates) => {
    task.description = updates.description;
    return task;
  });

  for (const [index, name] of ['Persona', 'Goal', 'Benefit', 'Success'].entries()) {
    await handleWebhook({
      event: 'taskUpdated',
      task_id: task.id,
      history_items: [{
        field: 'custom_field',
        custom_field: { id: name.toLowerCase(), name, type: 'short_text' },
        before: 'old value',
        after: `stale ${index}`
      }]
    });
  }

  assert.equal(get.mock.callCount(), 4);
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments, [
    'test-task',
    { description: 'User Story (managed)\nEnd user reduce setup time faster onboarding.\nSuccess is when users finish setup in minutes.\nEnd User Story (managed)' }
  ]);
});

test('description automation reports missing input fields without writing', async t => {
  const task = {
    id: 'test-task',
    list: { id: sprintRouting.backlogListId },
    custom_fields: [{ id: 'goal', name: 'Goal', type: 'short_text', value: 'New goal' }]
  };
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const update = t.mock.method(ClickUpClient.prototype, 'updateTask', async () => ({}));
  const { logger } = require('../src/utils/logger');
  const warn = t.mock.method(logger, 'warn', () => {});

  await handleWebhook({
    event: 'taskUpdated',
    task_id: task.id,
    history_items: [{
      field: 'custom_field',
      custom_field: { id: 'goal', name: 'Goal', type: 'short_text' },
      after: 'New goal'
    }]
  });

  assert.equal(update.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /incomplete-story-inputs/);
});

test('multiple matching history items dispatch a rule only once', async t => {
  t.mock.method(ClickUpClient.prototype, 'getTask', async () => ({ id: 'test-task' }));
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => ({}));
  const event = eventFor(null, 3);
  event.history_items.push({ ...event.history_items[0] });

  await handleWebhook(event);

  assert.equal(route.mock.callCount(), 1);
});

const priorityId = 'priority-field';
const businessValueId = 'business-value-field';
const priorityOptions = [
  { id: 'must-have', name: 'Must Have', orderindex: 1 },
  { id: 'minor', name: 'Minor Impact', orderindex: 4 },
  { id: 'critical', name: 'Critical (Blocker, No work around)', orderindex: 0 },
  { id: 'workaround', name: 'Workaround Exists', orderindex: 2 },
  { id: 'nice', name: 'Nice to Have', orderindex: 3 }
];

function priorityEvent(after = 'must-have') {
  const event = eventFor(null, after);
  event.history_items[0].custom_field = {
    id: priorityId, name: 'Backlog Priority', type: 'drop_down'
  };
  return event;
}

function priorityTask(value, businessValue = 1) {
  return {
    id: 'test-task',
    status: { status: 'in progress' },
    custom_fields: [
      {
        id: priorityId, name: 'Backlog Priority', type: 'drop_down',
        value, type_config: { options: priorityOptions }
      },
      { id: businessValueId, name: 'Business Value', type: 'number', value: businessValue }
    ]
  };
}

test('priority options map to Business Value regardless of status or dropdown ordering', async t => {
  const cases = [
    { selected: 0, expected: 10, status: 'complete' },
    { selected: 'must-have', expected: 7, status: 'awaiting estimation' },
    { selected: '2', expected: 5, status: 'ready to schedule' },
    { selected: 'nice', expected: 3, status: 'in progress' },
    { selected: 4, expected: 2, status: 'new backlog' }
  ];
  for (const { selected, expected, status } of cases) {
    await t.test(`${selected} -> ${expected} (${status})`, async t => {
      const task = priorityTask(selected);
      task.status.status = status;
      t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
      const set = t.mock.method(ClickUpClient.prototype, 'setCustomFieldValue', async () => ({}));
      const clear = t.mock.method(ClickUpClient.prototype, 'clearCustomFieldValue', async () => ({}));
      const statusUpdate = t.mock.method(ClickUpClient.prototype, 'updateTaskStatus', async () => ({}));

      await handleWebhook(priorityEvent(selected));

      assert.equal(set.mock.callCount(), 1);
      assert.deepEqual(set.mock.calls[0].arguments, ['test-task', businessValueId, expected]);
      assert.equal(clear.mock.callCount(), 0);
      assert.equal(statusUpdate.mock.callCount(), 0);
    });
  }
});

test('clearing priority clears Business Value, but already-correct targets need no writes', async t => {
  const cases = [
    { selected: null, target: 7, clears: 1 },
    { selected: undefined, target: 0, clears: 1 },
    { selected: '', target: 5, clears: 1 },
    { selected: null, target: null, clears: 0 },
    { selected: 1, target: '7', clears: 0 }
  ];
  for (const { selected, target, clears } of cases) {
    await t.test(`${String(selected)} with target ${String(target)}`, async t => {
      t.mock.method(ClickUpClient.prototype, 'getTask', async () => priorityTask(selected, target));
      const set = t.mock.method(ClickUpClient.prototype, 'setCustomFieldValue', async () => ({}));
      const clear = t.mock.method(ClickUpClient.prototype, 'clearCustomFieldValue', async () => ({}));

      await handleWebhook(priorityEvent(selected));

      assert.equal(set.mock.callCount(), 0);
      assert.equal(clear.mock.callCount(), clears);
      if (clears) {
        assert.deepEqual(clear.mock.calls[0].arguments, ['test-task', businessValueId]);
      }
    });
  }
});

test('priority uses the current selection rather than a stale event and avoids feedback loops', async t => {
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => priorityTask('nice'));
  const set = t.mock.method(ClickUpClient.prototype, 'setCustomFieldValue', async () => ({}));

  await handleWebhook(priorityEvent('critical'));
  assert.deepEqual(set.mock.calls[0].arguments, ['test-task', businessValueId, 3]);

  const feedback = priorityEvent();
  feedback.history_items[0].custom_field = { id: businessValueId, name: 'Business Value' };
  await handleWebhook(feedback);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(set.mock.callCount(), 1);
});

test('unmapped selections and missing target fields report errors without writing', async t => {
  for (const missingTarget of [false, true]) {
    await t.test(missingTarget ? 'missing target' : 'unmapped selection', async t => {
      const task = priorityTask('unknown-option');
      if (missingTarget) task.custom_fields.pop();
      t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
      const set = t.mock.method(ClickUpClient.prototype, 'setCustomFieldValue', async () => ({}));
      const clear = t.mock.method(ClickUpClient.prototype, 'clearCustomFieldValue', async () => ({}));
      const { logger } = require('../src/utils/logger');
      const error = t.mock.method(logger, 'error', () => {});

      await handleWebhook(priorityEvent());

      assert.equal(set.mock.callCount(), 0);
      assert.equal(clear.mock.callCount(), 0);
      assert.equal(error.mock.callCount(), 1);
      assert.match(error.mock.calls[0].arguments[0], /backlog-priority-to-business-value/);
    });
  }
});

test('both rules share one task fetch and one failing rule does not block the other', async t => {
  const task = priorityTask('must-have');
  task.status.status = 'awaiting estimation';
  task.custom_fields.push({ id: fieldId, name: 'Effort Estimate', value: 3 });
  const get = t.mock.method(ClickUpClient.prototype, 'getTask', async () => task);
  const route = t.mock.method(SprintRouting.prototype, 'reconcileTask', async () => {
    throw new Error('test API failure');
  });
  const set = t.mock.method(ClickUpClient.prototype, 'setCustomFieldValue', async () => ({}));
  const { logger } = require('../src/utils/logger');
  const error = t.mock.method(logger, 'error', () => {});
  const event = priorityEvent();
  event.history_items.push(eventFor(null, 3).history_items[0]);

  await handleWebhook(event);

  assert.equal(get.mock.callCount(), 1);
  assert.equal(route.mock.callCount(), 1);
  assert.equal(error.mock.callCount(), 1);
  assert.deepEqual(set.mock.calls[0].arguments, ['test-task', businessValueId, 7]);
});

test('task comments use ClickUp rich text for formatted segments and preserve plain-text posts', async () => {
  const clickup = new ClickUpClient();
  const requests = [];
  clickup.client.defaults.adapter = async config => {
    requests.push({ method: config.method, url: config.url, body: JSON.parse(config.data) });
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  const comment = [{ text: 'ITEM TYPE', attributes: { bold: true, italic: true } }];

  await clickup.addTaskComment('test-task', comment);
  await clickup.addTaskComment('test-task', 'Plain comment', false);

  assert.deepEqual(requests, [
    { method: 'post', url: '/task/test-task/comment', body: { comment, notify_all: true } },
    { method: 'post', url: '/task/test-task/comment', body: { comment_text: 'Plain comment', notify_all: false } }
  ]);
});

test('custom field writes use ClickUp POST and DELETE endpoints', async () => {
  const clickup = new ClickUpClient();
  const requests = [];
  clickup.client.defaults.adapter = async config => {
    requests.push({ method: config.method, url: config.url, body: config.data });
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };

  await clickup.setCustomFieldValue('test-task', businessValueId, 7);
  await clickup.clearCustomFieldValue('test-task', businessValueId);

  assert.deepEqual(requests, [
    { method: 'post', url: `/task/test-task/field/${businessValueId}`, body: '{"value":7}' },
    { method: 'delete', url: `/task/test-task/field/${businessValueId}`, body: undefined }
  ]);
});

test('ClickUp plan-limit errors retain actionable API details without logging credentials or unrelated response data', async t => {
  const clickup = new ClickUpClient();
  const { logger } = require('../src/utils/logger');
  const logged = t.mock.method(logger, 'error', () => {});
  clickup.client.defaults.adapter = async () => {
    const error = new Error('Request failed with status code 400');
    error.config = { headers: { Authorization: 'private-test-token' } };
    error.response = {
      status: 400,
      data: { err: 'Custom field usages exceeded for your plan', ECODE: 'FIELD_033', unrelated: 'private-test-data' }
    };
    throw error;
  };
  await assert.rejects(clickup.setCustomFieldValue('test-task', 'assigned', 'Sprint 1'),
    /Custom field usages exceeded for your plan \(FIELD_033\)/);
  const output = JSON.stringify(logged.mock.calls.map(call => call.arguments));
  assert.match(output, /FIELD_033/);
  assert.doesNotMatch(output, /private-test-token|private-test-data/);
});

test('task dates and paginated List reads use the documented API shapes', async () => {
  const clickup = new ClickUpClient();
  const requests = [];
  clickup.client.defaults.adapter = async config => {
    requests.push(config);
    let data = {};
    if (config.method === 'get' && config.url.endsWith('/task')) {
      data = config.params.page === 0 ?
        { tasks: [{ id: 'a' }], last_page: false } : { tasks: [{ id: 'b' }], last_page: true };
    } else if (config.url.includes('/folder/')) {
      data = { lists: [] };
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  await clickup.updateTask('test-task', { status: 'sprint 0', start_date: 100, due_date: 200 });
  const tasks = await clickup.getListTasks('backlog');
  await clickup.getFolderLists('sprints', true);
  assert.deepEqual(JSON.parse(requests[0].data), { status: 'sprint 0', start_date: 100, due_date: 200 });
  assert.equal(requests[0].method, 'put');
  assert.deepEqual(tasks.map(task => task.id), ['a', 'b']);
  assert.equal(requests[1].params.include_closed, true);
  assert.equal(requests[1].params.subtasks, true);
  assert.equal(requests[2].params.page, 1);
  assert.equal(requests[3].params.archived, true);
});
