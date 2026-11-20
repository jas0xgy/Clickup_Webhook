const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Estimation } = require('../src/services/estimation');
const { SprintTasks } = require('../src/services/sprintTasks');
const { ClickUpClient } = require('../src/services/clickupClient');

const config = {
  backlogListId: 'backlog', sprintFolderId: 'sprints',
  estimation: {
    enabled: true, triggerStatus: 'awaiting estimation', listId: 'estimation',
    initialStatus: 'awaiting estimate', readyStatus: 'estimate ready', estimateField: 'Effort Estimate'
  }
};
const clone = value => structuredClone(value);

function fixture() {
  const source = {
    id: 'source', name: 'Backlog item', url: 'https://app.clickup.com/t/source',
    list: { id: 'backlog' }, status: { status: 'awaiting estimation' }, description: 'Story text',
    linked_tasks: [],
    custom_fields: [
      { id: 'estimate', name: 'Effort Estimate', type: 'number' },
      { id: 'type', name: 'Item Type', type: 'drop_down', value: 0,
        type_config: { options: [{ id: 'f', name: 'Feature', orderindex: 0 }] } }
    ]
  };
  const store = new Map([[source.id, source]]);
  const writes = [];
  const client = {
    getCustomField: ClickUpClient.prototype.getCustomField,
    getDropdownOption: ClickUpClient.prototype.getDropdownOption,
    getTask: async id => clone(store.get(id)),
    getList: async id => ({ id, statuses: [{ status: 'Awaiting Estimate' }, { status: 'estimate ready' }] }),
    getListTasks: async (id, { archived = false } = {}) => [...store.values()]
      .filter(item => item.list.id === id && Boolean(item.archived) === archived).map(clone),
    createTask: async (listId, payload) => {
      writes.push(['create', listId, clone(payload)]);
      const item = {
        id: 'copy', name: payload.name, description: payload.description, list: { id: listId },
        status: { status: payload.status }, linked_tasks: [{ task_id: 'copy', link_id: payload.links_to }],
        custom_fields: [{ id: 'estimate', name: 'Effort Estimate', type: 'number' }]
      };
      store.set(item.id, item);
      source.linked_tasks.push({ task_id: source.id, link_id: item.id });
      return clone(item);
    },
    setCustomFieldValue: async (id, fieldId, value) => {
      writes.push(['field', id, fieldId, value]);
      store.get(id).custom_fields.find(field => field.id === fieldId).value = value;
    },
    addTaskComment: async (id, text) => { writes.push(['comment', id, text]); },
    updateTask: async (id, updates) => {
      writes.push(['update', id, clone(updates)]);
      Object.assign(store.get(id), updates.status ? { status: { status: updates.status } } : updates);
    }
  };
  const sprintRouting = { withTaskLock: (id, action) => action(), sprintTasks: new SprintTasks(client, config) };
  return { service: new Estimation(client, config, sprintRouting), source, store, writes };
}

test('awaiting estimation creates one estimation copy with the description, backlink, and tags', async () => {
  const { service, source, writes } = fixture();
  source.custom_fields.push({
    id: 'platform', name: 'Platform', type: 'drop_down', value: 'web',
    type_config: { options: [{ id: 'web', name: 'Web', orderindex: 0 }] }
  });
  assert.equal((await service.request(clone(source))).outcome, 'applied');
  const [, listId, payload] = writes[0];
  assert.equal(listId, 'estimation');
  assert.equal(payload.status, 'Awaiting Estimate');
  assert.equal(payload.links_to, 'source');
  assert.equal(payload.description, `Story text\n\nBacklog task: ${source.url}`);
  assert.deepEqual(payload.tags, ['Feature', 'Web']);
  assert.equal((await service.request(clone(source))).outcome, 'unchanged');
  assert.equal(writes.length, 1);
});

test('estimation generates a missed story from current fields before copying', async () => {
  const { service, source, writes } = fixture();
  source.description = '';
  source.custom_fields.push(...['Persona', 'Goal', 'Benefit', 'Success'].map(name =>
    ({ id: name, name, type: 'short_text', value: name })));
  await service.request(clone(source));
  assert.deepEqual(writes.map(([action]) => action), ['update', 'create']);
  const story = writes[0][2].description;
  assert.match(story, /User Story \(managed\)\nPersona Goal Benefit\.\nSuccess is when Success\./);
  assert.equal(writes[1][2].description, `${story}\n\nBacklog task: ${source.url}`);
});

test('estimate ready copies a positive Effort Estimate to the backlog task once', async () => {
  const { service, source, store, writes } = fixture();
  await service.request(clone(source));
  const copy = store.get('copy');
  copy.status = { status: 'estimate ready' };
  copy.custom_fields[0].value = '5';
  assert.equal((await service.complete(clone(copy))).outcome, 'applied');
  assert.deepEqual(writes.at(-1), ['field', 'source', 'estimate', 5]);
  assert.equal((await service.complete(clone(copy))).outcome, 'unchanged');
  assert.equal(writes.length, 2);
});

test('estimate ready with no estimate flags the estimation task without touching the backlog', async () => {
  const { service, source, store, writes } = fixture();
  await service.request(clone(source));
  const copy = { ...store.get('copy'), status: { status: 'estimate ready' } };
  copy.custom_fields = [{ id: 'estimate', name: 'Effort Estimate', type: 'number', value: '0' }];
  assert.equal((await service.complete(clone(copy))).outcome, 'flagged');
  assert.equal(writes.at(-1)[0], 'comment');
  assert.equal(writes.at(-1)[1], 'copy');
  assert.equal(store.get('source').custom_fields[0].value, undefined);
});

test('scheduling archives the estimation copy, and returning to awaiting estimation restores it', async () => {
  const { archiveCopiesOnStatus } = require('../src/services/managedCopies');
  const { service, source, store, writes } = fixture();
  await service.request(clone(source));
  const settings = { ...config.estimation, archiveOnStatuses: ['sprint 0', 'sprint +1', 'sprint +2'] };
  const archive = task => archiveCopiesOnStatus({
    clickup: service.clickup, config, task, settings, label: 'estimation'
  });
  assert.equal((await archive({ ...clone(store.get('source')), status: { status: 'sprint +1' } })).outcome, 'applied');
  assert.equal(store.get('copy').archived, true);
  assert.equal((await archive({ ...clone(store.get('source')), status: { status: 'sprint +1' } })).outcome, 'unchanged');
  assert.equal((await archive({ ...clone(store.get('source')), status: { status: 'ready to schedule' } })).outcome, 'skipped');

  const before = writes.filter(write => write[0] === 'create').length;
  assert.equal((await service.request(clone(store.get('source')))).outcome, 'restored');
  assert.equal(store.get('copy').archived, false);
  assert.equal(store.get('copy').status.status, 'Awaiting Estimate');
  assert.equal(writes.filter(write => write[0] === 'create').length, before);
});
