const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SprintTasks } = require('../src/services/sprintTasks');
const { ClickUpClient } = require('../src/services/clickupClient');

const config = {
  workspaceId: 'workspace', sprintFolderId: 'folder',
  sprintTasks: { initialStatus: 'ready for development' }
};
const fieldDefinitions = [
  {
    id: 'product', name: 'Product', type: 'drop_down',
    type_config: { options: [
      { id: 'product-b', name: 'B', orderindex: 1 },
      { id: 'product-a', name: 'A', orderindex: 0 }
    ] }
  },
  {
    id: 'persona', name: 'Persona', type: 'drop_down',
    type_config: { options: [
      { id: 'persona-a', name: 'A', orderindex: 0 },
      { id: 'persona-b', name: 'B', orderindex: 1 }
    ] }
  }
];
const newCatalog = () => ({ sprints: [{ id: 's1', name: 'Sprint One' }, { id: 's2', name: 'Sprint Two' }] });
const clone = value => structuredClone(value);

function fixture() {
  const source = {
    id: 'backlog-task', name: 'Original task', url: 'https://app.clickup.com/t/backlog-task',
    list: { id: 'backlog' }, linked_tasks: [],
    custom_fields: clone(fieldDefinitions).map((field, index) => ({ ...field, value: index }))
  };
  const store = new Map([[source.id, source]]);
  const writes = [];
  let created = 0;
  const statuses = id => [
    { id: `${id}-ready`, status: 'ready for development' },
    { id: `${id}-development`, status: 'in development' }
  ];
  const link = (a, b) => {
    for (const [first, second] of [[a, b], [b, a]]) {
      const task = store.get(first);
      if (!task.linked_tasks.some(value => value.task_id === first && value.link_id === second)) {
        task.linked_tasks.push({ task_id: first, link_id: second });
      }
    }
  };
  const save = (id, fieldId, value) => {
    const field = store.get(id).custom_fields.find(item => item.id === fieldId);
    field.value = value === null ? undefined : field.type_config.options.find(option => option.id === value).orderindex;
  };
  const client = {
    getCustomField: ClickUpClient.prototype.getCustomField,
    getDropdownOption: ClickUpClient.prototype.getDropdownOption,
    getTask: async id => {
      if (!store.has(id)) throw new Error(`Unknown fixture task ${id}`);
      return clone(store.get(id));
    },
    getList: async id => ({ id, statuses: statuses(id) }),
    getListFields: async () => clone(fieldDefinitions),
    getListTasks: async (id, { archived = false } = {}) => [...store.values()]
      .filter(item => item.list.id === id && Boolean(item.archived) === archived).map(clone),
    createTask: async (id, payload) => {
      writes.push(['create', id, clone(payload)]);
      created += 1;
      const item = {
        id: `sprint-task-${created}`, name: payload.name, description: payload.description,
        list: { id }, folder: { id: 'folder' }, linked_tasks: [],
        status: clone(statuses(id).find(status => status.status === payload.status)),
        custom_fields: clone(fieldDefinitions)
      };
      store.set(item.id, item);
      for (const field of payload.custom_fields) save(item.id, field.id, field.value);
      link(item.id, payload.links_to);
      return clone(item);
    },
    updateTask: async (id, updates) => {
      writes.push(['update', id, clone(updates)]);
      Object.assign(store.get(id), updates);
    },
    setCustomFieldValue: async (id, fieldId, value) => {
      writes.push(['set', id, fieldId, value]);
      save(id, fieldId, value);
    },
    clearCustomFieldValue: async (id, fieldId) => {
      writes.push(['clear', id, fieldId]);
      save(id, fieldId, null);
    },
    addTaskLink: async (id, sourceId) => {
      writes.push(['link', id, sourceId]);
      link(id, sourceId);
    },
    moveTask: async (workspaceId, id, listId, options) => {
      writes.push(['move', workspaceId, id, listId, clone(options)]);
      const item = store.get(id);
      item.status = clone(statuses(listId).find(status => status.status === item.status.status));
      item.list.id = listId;
      return { task_id: id, new_list_id: listId };
    }
  };
  const manager = new SprintTasks(client, config);
  return { manager, client, source, store, writes };
}

test('create plan copies dropdown UUIDs (including index zero) and creates a linked ready task', async () => {
  const { manager, source, store, writes } = fixture();
  const catalog = newCatalog();
  const plan = await manager.prepare(source, catalog.sprints[0], catalog);
  assert.deepEqual(writes, []);
  assert.deepEqual(plan.create.custom_fields, [
    { id: 'product', value: 'product-a' }, { id: 'persona', value: 'persona-b' }
  ]);
  assert.equal(plan.create.links_to, source.id);
  assert.equal(plan.create.status, 'ready for development');
  const result = await manager.apply(plan, catalog);
  const item = store.get(result.itemId);
  assert.equal(item.name, source.name);
  assert.equal(item.list.id, 's1');
  assert.equal(item.status.status, 'ready for development');
  assert.equal(source.linked_tasks[0].link_id, item.id);
});

test('restart and duplicate deliveries reuse the same item, not a task with the same name', async () => {
  const { manager, client, source, store, writes } = fixture();
  const catalog = newCatalog();
  const first = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  const restarted = new SprintTasks(client, config);
  const next = newCatalog();
  const plan = await restarted.prepare(await client.getTask(source.id), next.sprints[0], next);
  assert.equal(plan.itemId, first.itemId);
  assert.equal(plan.changed, false);
  await restarted.apply(plan, next);
  assert.equal(store.size, 2);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
});

test('rescheduling moves the same item, preserves progress, and syncs name and cleared fields', async () => {
  const { manager, client, source, store, writes } = fixture();
  const catalog = newCatalog();
  const created = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  const item = store.get(created.itemId);
  item.status = { id: 's1-development', status: 'in development' };
  source.name = 'Renamed backlog task';
  source.custom_fields[0].value = 1;
  source.custom_fields[1].value = undefined;

  const plan = await manager.prepare(await client.getTask(source.id), catalog.sprints[1], catalog);
  assert.deepEqual(plan.moveOptions.status_mappings, [{
    source_status_id: 's1-development', destination_status_id: 's2-development'
  }]);
  await manager.apply(plan, catalog);
  assert.equal(item.list.id, 's2');
  assert.equal(item.status.status, 'in development');
  assert.equal(item.name, source.name);
  assert.equal(item.custom_fields[0].value, 1);
  assert.equal(item.custom_fields[1].value, undefined);
  assert.equal((await client.getListTasks('s1')).length, 0);
  assert.equal((await client.getListTasks('s2')).length, 1);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
  assert.ok(writes.some(write => write[0] === 'clear' && write[2] === 'persona'));
  assert.ok(!writes.some(write => write[0] === 'update' && Object.hasOwn(write[2], 'status')));
});

test('an ambiguous create response recovers by its remote marker rather than creating twice', async () => {
  const { manager, client, source, store, writes } = fixture();
  const create = client.createTask;
  client.createTask = async (...args) => {
    const item = await create(...args);
    store.get(item.id).linked_tasks = [];
    source.linked_tasks = [];
    throw new Error('test response lost after successful creation');
  };
  const catalog = newCatalog();
  const plan = await manager.prepare(source, catalog.sprints[0], catalog);
  await assert.rejects(manager.apply(plan, catalog), /response lost/);
  const restarted = new SprintTasks(client, config);
  const fresh = newCatalog();
  const recovered = await restarted.prepare(source, fresh.sprints[0], fresh);
  assert.equal(recovered.action, 'sync');
  assert.equal(recovered.linkRequired, true);
  await restarted.apply(recovered, fresh);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
  assert.equal(writes.filter(write => write[0] === 'link').length, 1);
});

test('destination fields/status and duplicate ownership are checked before any writes', async t => {
  for (const problem of ['wrong field', 'missing option', 'missing initial status', 'duplicate items']) {
    await t.test(problem, async () => {
      const { manager, client, source, store, writes } = fixture();
      if (problem === 'wrong field') {
        client.getListFields = async () => [{ ...fieldDefinitions[0], id: 'duplicate-product' }, fieldDefinitions[1]];
      } else if (problem === 'missing option') {
        client.getListFields = async () => [fieldDefinitions[0], {
          ...fieldDefinitions[1], type_config: { options: [] }
        }];
      } else if (problem === 'missing initial status') {
        client.getList = async () => ({ statuses: [{ id: 'x', status: 'backlog' }] });
      } else {
        for (const id of ['duplicate-a', 'duplicate-b']) {
          store.set(id, {
            id, list: { id: 's1' }, description: `Managed backlog task ID: ${source.id}`
          });
        }
      }
      const catalog = newCatalog();
      await assert.rejects(manager.prepare(source, catalog.sprints[0], catalog));
      assert.deepEqual(writes, []);
    });
  }
});

test('a same-name manual task is not adopted, and historical tasks are not backfilled', async () => {
  const { manager, source, store, writes } = fixture();
  store.set('manual', { id: 'manual', name: source.name, list: { id: 's1' }, description: 'Manual task' });
  const catalog = newCatalog();
  const historical = await manager.prepare(source, catalog.sprints[0], catalog, { allowCreate: false });
  assert.equal(historical.changed, false);
  const planned = await manager.prepare(source, catalog.sprints[0], catalog);
  assert.equal(planned.action, 'create');
  assert.deepEqual(writes, []);
});

test('missing permissions during discovery are surfaced rather than risking duplicate creation', async () => {
  const { manager, client, source, writes } = fixture();
  source.linked_tasks = [{ task_id: source.id, link_id: 'restricted' }];
  client.getTask = async () => {
    const error = new Error('Forbidden');
    error.response = { status: 403 };
    throw error;
  };
  const catalog = newCatalog();
  await assert.rejects(manager.prepare(source, catalog.sprints[0], catalog), /Forbidden/);
  assert.deepEqual(writes, []);
});

test('removed markers cannot silently create duplicate items', async () => {
  const { manager, client, source, store, writes } = fixture();
  const catalog = newCatalog();
  const result = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  store.get(result.itemId).description = 'Marker removed manually';
  await assert.rejects(manager.prepare(await client.getTask(source.id), catalog.sprints[0], newCatalog()),
    /unmarked sprint task/);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
});

test('unscheduling archives once; rescheduling restores the same item in the same or another sprint', async () => {
  for (const destination of [0, 1]) {
    const { manager, client, source, store, writes } = fixture();
    const catalog = newCatalog();
    const result = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
    const item = store.get(result.itemId);
    item.status = { id: 's1-development', status: 'in development' };
    const archived = await manager.prepare(source, null, catalog);
    assert.equal(archived.action, 'archive');
    assert.equal(item.archived, undefined);
    await manager.apply(archived, catalog);
    assert.equal(item.archived, true);
    assert.equal(item.status.status, 'in development');
    assert.equal((await client.getListTasks('s1')).length, 0);
    const before = writes.length;
    const restarted = new SprintTasks(client, config);
    await restarted.apply(await restarted.prepare(source, null, newCatalog()), newCatalog());
    assert.equal(writes.length, before);

    source.name = 'Changed while unscheduled';
    const paused = await restarted.prepare(source, catalog.sprints[0], newCatalog(), { allowCreate: false });
    assert.equal(paused.changed, false);
    assert.equal(item.archived, true);
    const restore = await restarted.prepare(source, catalog.sprints[destination], newCatalog());
    assert.equal(restore.itemId, item.id);
    assert.equal(restore.restoring, true);
    await restarted.apply(restore, catalog);
    assert.equal(item.archived, false);
    assert.equal(item.status.status, 'in development');
    assert.equal(item.name, source.name);
    assert.equal(item.list.id, catalog.sprints[destination].id);
    assert.equal(writes.filter(write => write[0] === 'create').length, 1);
  }
});

test('archived inventory recovers an unlinked item for rescheduling without a new copy', async () => {
  const { manager, source, store, writes } = fixture();
  const catalog = newCatalog();
  const result = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  await manager.apply(await manager.prepare(source, null, catalog), catalog);
  source.linked_tasks = [];
  store.get(result.itemId).linked_tasks = [];
  const fresh = newCatalog();
  const plan = await manager.prepare(source, fresh.sprints[1], fresh);
  assert.equal(plan.itemId, result.itemId);
  await manager.apply(plan, fresh);
  assert.equal(store.get(result.itemId).archived, false);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
});

test('ignored archive writes fail verification and never report success', async () => {
  const { manager, client, source } = fixture();
  const catalog = newCatalog();
  await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  client.updateTask = async () => ({});
  await assert.rejects(manager.apply(await manager.prepare(source, null, catalog), catalog), /archive state/);
});

test('rescheduling refuses to reset a development status absent from the destination', async () => {
  const { manager, client, source, store, writes } = fixture();
  const catalog = newCatalog();
  const result = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  store.get(result.itemId).status = { id: 's1-custom', status: 'custom development stage' };
  const before = writes.length;
  await assert.rejects(manager.prepare(source, catalog.sprints[1], catalog), /Cannot preserve/);
  assert.equal(writes.length, before);
  assert.equal((await client.getTask(result.itemId)).list.id, 's1');
});

test('move rechecks shared field values and repairs values dropped by ClickUp during the move', async () => {
  const { manager, client, source, store } = fixture();
  const catalog = newCatalog();
  const result = await manager.apply(await manager.prepare(source, catalog.sprints[0], catalog), catalog);
  const move = client.moveTask;
  client.moveTask = async (...args) => {
    const response = await move(...args);
    store.get(result.itemId).custom_fields[0].value = undefined;
    return response;
  };
  const plan = await manager.prepare(source, catalog.sprints[1], catalog);
  assert.equal(plan.fieldUpdates.length, 0);
  await manager.apply(plan, catalog);
  assert.equal(store.get(result.itemId).custom_fields[0].value, 0);
});

test('ignored custom-field writes fail verification and recover without another create', async () => {
  const { manager, client, source, store, writes } = fixture();
  const create = client.createTask;
  client.createTask = async (...args) => {
    const item = await create(...args);
    store.get(item.id).custom_fields[1].value = undefined;
    return item;
  };
  const catalog = newCatalog();
  await assert.rejects(manager.apply(
    await manager.prepare(source, catalog.sprints[0], catalog), catalog
  ), /did not retain/);
  const plan = await manager.prepare(source, catalog.sprints[0], catalog);
  await manager.apply(plan, catalog);
  assert.equal(writes.filter(write => write[0] === 'create').length, 1);
  assert.equal(store.get(plan.itemId).custom_fields[1].value, 1);
});

test('native create/link/move API payloads use the documented endpoints and version', async () => {
  const client = new ClickUpClient();
  const requests = [];
  client.client.defaults.adapter = async request => {
    requests.push(request);
    return {
      config: request, status: 200, statusText: 'OK', headers: {},
      data: request.url.includes('/api/v3/') ? { data: { task_id: 'item', new_list_id: 's2' } } :
        request.url.endsWith('/field') ? { fields: [] } :
          request.method === 'get' ? { tasks: [], last_page: true } : { id: 'item' }
    };
  };
  await client.createTask('s1', { name: 'Example', links_to: 'source' });
  await client.addTaskLink('item', 'source');
  await client.moveTask('workspace', 'item', 's2', {
    move_custom_fields: false,
    status_mappings: [{ source_status_id: 'old', destination_status_id: 'new' }]
  });
  assert.equal(requests[0].url, '/list/s1/task');
  assert.deepEqual(JSON.parse(requests[0].data), { name: 'Example', links_to: 'source' });
  assert.equal(requests[1].url, '/task/item/link/source');
  assert.equal(requests[2].url, 'https://api.clickup.com/api/v3/workspaces/workspace/tasks/item/home_list/s2');
  assert.equal(requests[2].method, 'put');
  assert.deepEqual(JSON.parse(requests[2].data).status_mappings, [
    { source_status_id: 'old', destination_status_id: 'new' }
  ]);
  assert.deepEqual(await client.getListFields('s2'), []);
  await client.getListTasks('s2', { archived: true });
  assert.equal(requests[3].url, '/list/s2/field');
  assert.equal(requests[4].params.archived, true);
});
