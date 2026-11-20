const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AcceptanceTesting } = require('../src/services/acceptanceTesting');
const { SprintRouting } = require('../src/services/sprintRouting');
const { ClickUpClient } = require('../src/services/clickupClient');

const config = {
  backlogListId: 'backlog', sprintFolderId: 'sprints', completedSprintIds: [],
  sprintTasks: { enabled: true, initialStatus: 'ready for development' },
  acceptanceTesting: {
    enabled: true, checkboxField: 'Ready for acceptance testing', listId: 'testing',
    testingStatus: 'ready to test', backlogStatus: 'in testing', sprintStatus: 'testing',
    completeStatus: 'test complete', backlogCompleteStatus: 'ready to deploy',
    sprintCompleteStatus: 'ready to ship',
    returnStatus: 'return to development', passedCheckboxField: 'Acceptance Testing Passed',
    sprintFailedStatus: 'failed testing'
  }
};
const statuses = {
  backlog: ['sprint 0', 'sprint +1', 'sprint +2', 'in testing', 'ready to deploy'],
  testing: ['ready to test', 'test in progress', 'test complete', 'return to development']
};
const sprints = [1, 2, 3].map(n => ({
  id: `s${n}`, name: `Sprint ${n}`, start_date: n * 10, due_date: n * 10 + 9
}));
const clone = value => structuredClone(value);

function fixture() {
  const source = {
    id: 'source', name: 'Backlog item', url: 'https://app.clickup.com/t/source',
    list: { id: 'backlog' }, status: { status: 'sprint 0' }, description: 'Story text',
    linked_tasks: [{ task_id: 'source', link_id: 'sprint-item' }],
    custom_fields: [
      { id: 'estimate', name: 'Effort Estimate', type: 'number', value: '3' },
      { id: 'assigned', name: 'Assigned Sprint', type: 'short_text', value: 'Sprint 1' }
    ]
  };
  const sprintItem = {
    id: 'sprint-item', name: 'Backlog item', list: { id: 's1' }, folder: { id: 'sprints' },
    status: { status: 'in development' },
    description: `Story text\n\nBacklog task: ${source.url}`,
    linked_tasks: [{ task_id: 'sprint-item', link_id: 'source' }],
    custom_fields: [{ id: 'ready', name: 'Ready for acceptance testing', type: 'checkbox', value: 'true' }]
  };
  const store = new Map([[source.id, source], [sprintItem.id, sprintItem]]);
  const writes = [];
  const client = {
    getCustomField: ClickUpClient.prototype.getCustomField,
    getDropdownOption: ClickUpClient.prototype.getDropdownOption,
    getTask: async id => clone(store.get(id)),
    getList: async id => ({
      id, statuses: (statuses[id] || ['in development', 'testing', 'FAILED TESTING', 'READY TO SHIP']).map(status => ({ status }))
    }),
    getFolderLists: async (_id, archived) => archived ? [] : sprints,
    getListTasks: async (id, { archived = false } = {}) => [...store.values()]
      .filter(item => item.list.id === id && Boolean(item.archived) === archived).map(clone),
    createTask: async (listId, payload) => {
      writes.push(['create', listId, clone(payload)]);
      const item = {
        id: `copy-${writes.length}`, name: payload.name, description: payload.description,
        list: { id: listId }, status: { status: payload.status }
      };
      item.linked_tasks = [{ task_id: item.id, link_id: payload.links_to }];
      store.set(item.id, item);
      source.linked_tasks.push({ task_id: source.id, link_id: item.id });
      return clone(item);
    },
    updateTask: async (id, updates) => {
      writes.push(['update', id, clone(updates)]);
      if (updates.status) store.get(id).status = { status: updates.status };
    },
    setCustomFieldValue: async (id, fieldId, value) => {
      writes.push(['field', id, fieldId, value]);
      store.get(id).custom_fields.find(field => field.id === fieldId).value = value;
    },
    addTaskComment: async (id, text) => { writes.push(['comment', id, text]); }
  };
  const sprintRouting = new SprintRouting(client, config, () => 15);
  return { service: new AcceptanceTesting(client, config, sprintRouting), source, sprintItem, store, writes };
}

test('checking the box creates one testing copy and moves the backlog and sprint tasks', async () => {
  const { service, source, sprintItem, store, writes } = fixture();
  source.custom_fields.push({
    id: 'platform', name: 'Platform', type: 'drop_down', value: 0,
    type_config: { options: [{ id: 'web', name: 'Web', orderindex: 0 }] }
  });
  const result = await service.handle(clone(sprintItem));
  assert.equal(result.outcome, 'applied');
  const [, listId, payload] = writes.find(write => write[0] === 'create');
  assert.equal(listId, 'testing');
  assert.equal(payload.status, 'ready to test');
  assert.equal(payload.links_to, 'source');
  assert.equal(payload.description, `Story text\n\nBacklog task: ${source.url}`);
  assert.equal(payload.points, 3);
  assert.deepEqual(payload.tags, ['Web']);
  assert.equal(store.get('sprint-item').status.status, 'testing');
  assert.equal(store.get('source').status.status, 'in testing');

  const before = writes.length;
  const again = await service.handle(clone(store.get('sprint-item')));
  assert.equal(again.copyId, result.copyId);
  assert.equal(writes.length, before);
});

test('checking the box moves an existing testing copy back to ready to test without duplicating it', async () => {
  const { service, source, sprintItem, store, writes } = fixture();
  store.set('manual-copy', {
    id: 'manual-copy', list: { id: 'testing' }, status: { status: 'return to development' },
    description: `Backlog task: ${source.url}`, linked_tasks: []
  });
  const result = await service.handle(clone(sprintItem));
  assert.equal(result.copyId, 'manual-copy');
  assert.equal(store.get('manual-copy').status.status, 'ready to test');
  assert.deepEqual(writes, [
    ['update', 'manual-copy', { status: 'ready to test' }],
    ['update', 'sprint-item', { status: 'testing' }],
    ['update', 'source', { status: 'in testing' }]
  ]);
});

test('unchecked boxes, tasks outside the Sprint Folder, and unlinked tasks never write', async () => {
  const { service, sprintItem, writes } = fixture();
  const unchecked = clone(sprintItem);
  unchecked.custom_fields[0].value = undefined;
  assert.equal((await service.handle(unchecked)).outcome, 'skipped');
  await assert.rejects(service.handle({ ...clone(sprintItem), folder: { id: 'elsewhere' } }), /not in the Sprint Folder/);
  await assert.rejects(service.handle({ ...clone(sprintItem), description: 'No link' }), /no "Backlog task:" link/);
  assert.deepEqual(writes, []);
});

function testingTask(source, status = 'test complete') {
  return {
    id: 'testing-item', name: source.name, list: { id: 'testing' }, status: { status },
    description: `Story text\n\nBacklog task: ${source.url}`, linked_tasks: [],
    custom_fields: [{ id: 'passed', name: 'Acceptance Testing Passed', type: 'checkbox', value: false }]
  };
}

test('completing testing moves the backlog and linked sprint tasks once', async () => {
  const { service, source, sprintItem, writes } = fixture();
  source.status.status = 'in testing';
  sprintItem.status.status = 'testing';
  assert.equal((await service.complete(testingTask(source))).outcome, 'applied');
  assert.equal((await service.complete(testingTask(source))).outcome, 'unchanged');
  assert.deepEqual(writes, [
    ['update', 'source', { status: 'ready to deploy' }],
    ['update', 'sprint-item', { status: 'READY TO SHIP' }]
  ]);
});

test('completion can finish the sprint update when the backlog is already ready to deploy', async () => {
  const { service, source, sprintItem, writes } = fixture();
  source.status.status = 'ready to deploy';
  sprintItem.status.status = 'testing';
  assert.equal((await service.complete(testingTask(source))).outcome, 'applied');
  assert.deepEqual(writes, [['update', 'sprint-item', { status: 'READY TO SHIP' }]]);
});

test('completing testing flags the testing task when the backlog task is not IN TESTING', async () => {
  const { service, source, store, writes } = fixture();
  assert.equal((await service.complete(testingTask(source))).outcome, 'flagged');
  assert.equal(store.get('source').status.status, 'sprint 0');
  assert.equal(writes.length, 1);
  const [kind, id, text] = writes[0];
  assert.equal(kind, 'comment');
  assert.equal(id, 'testing-item');
  assert.match(text, /SPRINT 0, not IN TESTING/);
});

test('completion ignores tasks outside the testing List or no longer complete', async () => {
  const { service, source, writes } = fixture();
  assert.equal((await service.complete({ ...testingTask(source), list: { id: 's1' } })).outcome, 'skipped');
  assert.equal((await service.complete(testingTask(source, 'test in progress'))).outcome, 'skipped');
  assert.deepEqual(writes, []);
});

test('returned testing items move both linked tasks once and preserve the sprint assignment', async t => {
  for (const [index, status] of ['sprint 0', 'sprint +1', 'sprint +2'].entries()) {
    await t.test(status, async () => {
      const { service, source, sprintItem, store, writes } = fixture();
      const sprint = sprints[index];
      source.status.status = 'in testing';
      source.custom_fields[1].value = sprint.name;
      sprintItem.list.id = sprint.id;
      sprintItem.status.status = 'testing';
      const testing = testingTask(source, 'Return to Development');
      testing.custom_fields[0].value = index === 0 ? true : 'true';
      store.set(testing.id, testing);

      assert.equal((await service.returnToDevelopment(clone(testing))).outcome, 'applied');
      assert.equal((await service.returnToDevelopment(clone(testing))).outcome, 'unchanged');
      assert.deepEqual(writes, [
        ['field', 'testing-item', 'passed', false],
        ['update', 'sprint-item', { status: 'FAILED TESTING' }],
        ['field', 'sprint-item', 'ready', false],
        ['update', 'source', { status }]
      ]);
    });
  }
});

test('return to development clears the passed checkbox even when the backlog is not moved', async () => {
  const { service, source, store, writes } = fixture();
  source.status.status = 'ready to deploy';
  const testing = testingTask(source, 'return to development');
  testing.custom_fields[0].value = true;
  store.set(testing.id, testing);

  assert.equal((await service.returnToDevelopment(clone(testing))).outcome, 'applied');
  assert.deepEqual(writes, [['field', 'testing-item', 'passed', false]]);
});

test('return to development ignores stale or other-list events and fails safely without a managed sprint item', async () => {
  const { service, source, sprintItem, writes } = fixture();
  const testing = testingTask(source, 'return to development');
  assert.equal((await service.returnToDevelopment({ ...testing, list: { id: 's1' } })).outcome, 'skipped');
  assert.equal((await service.returnToDevelopment(testingTask(source, 'test in progress'))).outcome, 'skipped');

  source.status.status = 'in testing';
  source.linked_tasks = [];
  sprintItem.description = 'No backlog link';
  await assert.rejects(service.returnToDevelopment(testing), /no active managed sprint task/);
  assert.deepEqual(writes, []);
});

test('return to development never reschedules a mismatch or overwrites a later backlog status', async () => {
  const { service, source, writes } = fixture();
  const testing = testingTask(source, 'return to development');
  source.status.status = 'ready to deploy';
  assert.equal((await service.returnToDevelopment(testing)).outcome, 'skipped');

  source.status.status = 'in testing';
  source.custom_fields[1].value = 'Sprint 2';
  await assert.rejects(service.returnToDevelopment(testing), /not in the Assigned Sprint "Sprint 2"/);
  assert.deepEqual(writes, []);
});
