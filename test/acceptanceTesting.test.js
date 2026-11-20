const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AcceptanceTesting } = require('../src/services/acceptanceTesting');
const { SprintTasks } = require('../src/services/sprintTasks');
const { ClickUpClient } = require('../src/services/clickupClient');

const config = {
  backlogListId: 'backlog', sprintFolderId: 'sprints',
  sprintTasks: { initialStatus: 'ready for development' },
  acceptanceTesting: {
    enabled: true, checkboxField: 'Ready for acceptance testing', listId: 'testing',
    testingStatus: 'ready to test', backlogStatus: 'in testing', sprintStatus: 'testing',
    completeStatus: 'test complete', backlogCompleteStatus: 'ready to deploy'
  }
};
const statuses = {
  backlog: ['sprint 0', 'in testing', 'ready to deploy'], s1: ['in development', 'testing'],
  testing: ['ready to test', 'test in progress', 'test complete']
};
const clone = value => structuredClone(value);

function fixture() {
  const source = {
    id: 'source', name: 'Backlog item', url: 'https://app.clickup.com/t/source',
    list: { id: 'backlog' }, status: { status: 'sprint 0' }, description: 'Story text',
    linked_tasks: [{ task_id: 'source', link_id: 'sprint-item' }],
    custom_fields: [{ id: 'estimate', name: 'Effort Estimate', type: 'number', value: '3' }]
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
    getList: async id => ({ id, statuses: statuses[id].map(status => ({ status })) }),
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
    addTaskComment: async (id, text) => { writes.push(['comment', id, text]); }
  };
  const sprintRouting = {
    withTaskLock: (id, action) => action(),
    sprintTasks: new SprintTasks(client, config)
  };
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

test('an existing unlinked copy in the testing List is reused instead of duplicated', async () => {
  const { service, source, sprintItem, store, writes } = fixture();
  store.set('manual-copy', {
    id: 'manual-copy', list: { id: 'testing' }, status: { status: 'test in progress' },
    description: `Backlog task: ${source.url}`, linked_tasks: []
  });
  const result = await service.handle(clone(sprintItem));
  assert.equal(result.copyId, 'manual-copy');
  assert.ok(!writes.some(write => write[0] === 'create'));
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
    description: `Story text\n\nBacklog task: ${source.url}`, linked_tasks: []
  };
}

test('completing testing moves the IN TESTING backlog task to READY TO DEPLOY once', async () => {
  const { service, source, store, writes } = fixture();
  store.get('source').status = { status: 'in testing' };
  assert.equal((await service.complete(testingTask(source))).outcome, 'applied');
  assert.equal(store.get('source').status.status, 'ready to deploy');
  assert.equal((await service.complete(testingTask(source))).outcome, 'unchanged');
  assert.equal(writes.length, 1);
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
