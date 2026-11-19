const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SprintRouting, buildCatalog } = require('../src/services/sprintRouting');
const { ClickUpClient } = require('../src/services/clickupClient');

const config = { backlogListId: 'backlog', sprintFolderId: 'sprints', completedSprintIds: [] };
const statuses = ['new backlog', 'awaiting estimation', 'ready to schedule',
  'sprint 0', 'sprint +1', 'sprint +2', 'in testing', 'ready to deploy', 'deployed', 'complete'];
const lists = [
  { id: '1', name: 'Sprint 1 (11/16 - 11/29)', start_date: '1794805200000', due_date: '1796014799999', archived: false },
  { id: '2', name: 'Sprint 2 (11/30 - 12/13)', start_date: '1796014800000', due_date: '1797224399999', archived: false },
  { id: '3', name: 'Sprint 3 (12/14 - 12/27)', start_date: '1797224400000', due_date: '1798433999999', archived: false }
];
const initialNow = Date.parse('2026-11-17T17:00:00Z');

function task(status = 'awaiting estimation', assigned = null, estimate = 3) {
  return {
    id: 'task', list: { id: 'backlog' }, status: { status },
    custom_fields: [
      { id: 'estimate', name: 'Effort Estimate', type: 'number', value: estimate },
      { id: 'assigned', name: 'Assigned Sprint', type: 'short_text', value: assigned }
    ]
  };
}

function fixture({ now = initialNow, completed = [], sprintLists = lists, taskStatuses = statuses } = {}) {
  const writes = [];
  const client = {
    getCustomField: ClickUpClient.prototype.getCustomField,
    setCustomFieldValue: async (...args) => { writes.push(['field', ...args]); },
    clearCustomFieldValue: async (...args) => { writes.push(['clear', ...args]); },
    updateTask: async (...args) => { writes.push(['task', ...args]); },
    getFolderLists: async (id, archived) => sprintLists.filter(list => Boolean(list.archived) === archived),
    getList: async () => ({ statuses: taskStatuses }),
    getListTasks: async () => [],
    getTask: async () => { throw new Error('Unexpected task fetch'); }
  };
  const router = new SprintRouting(client, { ...config, completedSprintIds: completed }, () => now);
  return { router, client, writes };
}

const statusChange = (after, before = 'new backlog') => ({
  field: 'status', before: { status: before }, after: { status: after }
});
const assignedChange = after => ({
  field: 'custom_field', custom_field: { id: 'assigned', name: 'Assigned Sprint' }, before: 'old', after
});

test('positive-estimate tasks moved backward route by their permanent sprint assignment', async t => {
  const cases = [
    { assigned: null, expected: 'ready to schedule' },
    { assigned: '', expected: 'ready to schedule' },
    { assigned: lists[0].name, expected: 'sprint 0' },
    { assigned: lists[1].name, expected: 'sprint +1' },
    { assigned: lists[2].name, expected: 'sprint +2' }
  ];
  for (const { assigned, expected } of cases) {
    await t.test(`${String(assigned)} -> ${expected}`, async () => {
      const { router, writes } = fixture();
      const item = task('new backlog', assigned);
      const plan = await router.reconcileTask(item, { changes: [statusChange('new backlog', 'sprint 0')] });
      assert.equal(plan.targetStatus, expected);
      assert.equal(plan.assignment, null);
      assert.equal(writes.length, 1);
      assert.equal(writes[0][2].status, expected);
      if (assigned) {
        const sprint = lists.find(list => list.name === assigned);
        assert.equal(writes[0][2].start_date, Number(sprint.start_date));
        assert.equal(writes[0][2].due_date, Number(sprint.due_date));
      }
    });
  }
});

test('unestimated tasks, other Lists, and protected workflow stages are not rerouted', async t => {
  const cases = [
    ...[0, null, '', -1, 'invalid', true].map(estimate => task('new backlog', null, estimate)),
    ...['in testing', 'ready to deploy', 'deployed', 'complete'].map(status => task(status, lists[0].name)),
    { ...task(), list: { id: 'another-list' } }
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(`case ${index}`, async () => {
      const { router, writes } = fixture();
      const result = await router.reconcileTask(item);
      assert.equal(result.outcome, 'skipped');
      assert.deepEqual(writes, []);
    });
  }
});

test('explicit sprint status moves assign or reassign a sprint with exact dates', async t => {
  for (const [offset, status] of ['sprint 0', 'sprint +1', 'sprint +2'].entries()) {
    await t.test(status, async () => {
      const { router, writes } = fixture();
      const item = task(status, offset === 0 ? null : lists[0].name);
      const plan = await router.reconcileTask(item, { changes: [statusChange(status)] });
      assert.equal(plan.assignedSprint, lists[offset].name);
      assert.deepEqual(writes[0], ['field', 'task', 'assigned', lists[offset].name]);
      assert.deepEqual(writes[1], ['task', 'task', {
        start_date: Number(lists[offset].start_date), start_date_time: true,
        due_date: Number(lists[offset].due_date), due_date_time: true
      }]);
    });
  }
});

test('daily rollover changes relative status without reassigning, including status feedback events', async () => {
  const { router, writes } = fixture({ now: Date.parse('2026-11-30T05:00:00Z') });
  const item = task('sprint +1', lists[1].name);
  item.start_date = lists[1].start_date;
  item.due_date = lists[1].due_date;
  const first = await router.reconcileTask(item);
  assert.equal(first.targetStatus, 'sprint 0');
  assert.deepEqual(writes, [['task', 'task', { status: 'sprint 0' }]]);
  const feedback = await router.reconcileTask(item, {
    changes: [statusChange('sprint 0', 'sprint +1')]
  });
  assert.equal(feedback.outcome, 'unchanged');
  assert.equal(item.custom_fields[1].value, lists[1].name);
  assert.equal(writes.length, 1);
});

test('elapsed or archived is not completed; only registered sprint IDs route to testing', async t => {
  const afterSprint = Date.parse('2026-11-30T05:00:00Z');
  for (const archived of [false, true]) {
    await t.test(`ended, archived=${archived}`, async () => {
      const { router } = fixture({
        now: afterSprint, sprintLists: lists.map(list => ({ ...list, archived: list.id === '1' && archived }))
      });
      const result = await router.reconcileTask(task('new backlog', lists[0].name));
      assert.equal(result.targetStatus, 'sprint 0');
      assert.equal(result.assignedSprint, lists[0].name);
    });
  }
  const { router } = fixture({ now: afterSprint, completed: ['1'] });
  const result = await router.reconcileTask(task('new backlog', lists[0].name));
  assert.equal(result.targetStatus, 'in testing');
});

test('an ended, uncompleted sprint stays Sprint 0 even after its status feedback arrives', async () => {
  const { router, writes } = fixture({ now: Date.parse('2026-12-01T12:00:00Z') });
  const item = task('sprint 0', lists[0].name);
  item.start_date = lists[0].start_date;
  item.due_date = lists[0].due_date;
  const result = await router.reconcileTask(item, { changes: [statusChange('sprint 0')] });
  assert.equal(result.assignedSprint, lists[0].name);
  assert.deepEqual(writes, []);
});

test('unassignment clears dates and does not immediately schedule the task again', async () => {
  const { router, writes } = fixture();
  const item = task('sprint +1');
  item.start_date = lists[1].start_date;
  item.due_date = lists[1].due_date;
  await router.reconcileTask(item, { changes: [assignedChange(null)] });
  assert.deepEqual(writes, [['task', 'task', {
    status: 'ready to schedule', start_date: null, due_date: null
  }]]);
});

test('unassignment clears dates without pulling a protected task backward', async () => {
  const { router, writes } = fixture();
  const item = task('in testing');
  item.start_date = 100;
  item.due_date = 200;
  await router.reconcileTask(item, { changes: [assignedChange(null)] });
  assert.deepEqual(writes, [['task', 'task', { start_date: null, due_date: null }]]);
});

test('linked sprint task preflight runs before source writes, including read-only create previews', async () => {
  const { router, writes } = fixture();
  const calls = [];
  router.sprintTasks = {
    prepare: async (source, sprint, catalog, options) => {
      assert.deepEqual(writes, []);
      calls.push({ sprint, options });
      return { changed: true, action: 'create', listId: sprint.id };
    },
    apply: async plan => { calls.push('applied'); return { ...plan, itemId: 'linked-item' }; }
  };
  const source = task('sprint +1');
  const preview = await router.reconcileTask(source, { changes: [statusChange('sprint +1')], dryRun: true });
  assert.equal(preview.sprintTask.action, 'create');
  assert.equal(preview.sprintTask.listId, '2');
  assert.equal(calls.length, 1);
  assert.deepEqual(writes, []);
  const applied = await router.reconcileTask(source, { changes: [statusChange('sprint +1')] });
  assert.equal(applied.sprintTask.itemId, 'linked-item');
  assert.equal(calls[1].options.allowCreate, true);
  assert.equal(calls[2], 'applied');
  assert.equal(writes.length, 2);
});

test('invalid linked-task destination stops scheduling before source assignment/dates are changed', async () => {
  const { router, writes } = fixture();
  router.sprintTasks = { prepare: async () => { throw new Error('Missing shared Product field'); } };
  await assert.rejects(router.reconcileTask(task('sprint +1'), {
    changes: [statusChange('sprint +1')]
  }), /Missing shared Product/);
  assert.deepEqual(writes, []);
});

test('unchanged backlog routing still repairs or backfills the linked sprint item', async () => {
  const { router, writes } = fixture();
  const source = task('sprint 0', lists[0].name);
  source.start_date = lists[0].start_date;
  source.due_date = lists[0].due_date;
  let applied = 0;
  router.sprintTasks = {
    prepare: async () => ({ changed: true, action: 'create' }),
    apply: async plan => { applied += 1; return plan; }
  };
  const result = await router.reconcileTask(source);
  assert.equal(result.outcome, 'updated');
  assert.equal(applied, 1);
  assert.deepEqual(writes, []);
});

test('name and Product changes sync existing items but Persona changes do not', async () => {
  for (const status of ['new backlog', 'in testing']) {
    const { router, writes } = fixture();
    const source = task(status, lists[0].name);
    source.custom_fields.push(
      { id: 'product', name: 'Product' }, { id: 'persona', name: 'Persona' }
    );
    let applied = 0;
    router.sprintTasks = {
      prepare: async (item, sprint, catalog, options) => {
        assert.equal(sprint.id, '1');
        assert.equal(options.allowCreate, false);
        return { changed: true, action: 'sync' };
      },
      apply: async plan => { applied += 1; return plan; }
    };
    for (const change of [
      { field: 'name', before: 'Old', after: 'New' },
      { field: 'custom_field', custom_field: { id: 'product', name: 'Product' } }
    ]) {
      const result = await router.reconcileTask(source, { changes: [change] });
      assert.equal(result.targetStatus, status);
      assert.deepEqual(writes, []);
    }
    const persona = await router.reconcileTask(source, { changes: [{
      field: 'custom_field', custom_field: { id: 'persona', name: 'Persona' }
    }] });
    assert.equal(persona.outcome, 'skipped');
    const stale = await router.reconcileTask(source, { changes: [{
      field: 'custom_field', custom_field: { id: 'old-product', name: 'Product' }
    }] });
    assert.equal(stale.outcome, 'skipped');
    assert.equal(applied, 2);
  }
});

test('unassignment archives linked sprint tasks and metadata events do not restore them', async () => {
  const { router } = fixture();
  let applied = 0;
  router.sprintTasks = {
    prepare: async (source, sprint) => {
      assert.equal(sprint, null);
      return { changed: applied === 0, action: 'archive' };
    },
    apply: async plan => { applied += 1; return plan; }
  };
  const result = await router.reconcileTask(task('sprint +1'), { changes: [assignedChange(null)] });
  assert.equal(result.targetStatus, 'ready to schedule');
  const metadata = await router.reconcileTask(task('ready to schedule'), { changes: [{ field: 'name' }] });
  assert.equal(metadata.outcome, 'unchanged');
  assert.equal(metadata.sprintTask.action, 'archive');
});

test('dragging from any sprint to any other sprint updates assignment and selects the linked item destination', async () => {
  const columns = ['sprint 0', 'sprint +1', 'sprint +2'];
  for (const [from, previous] of columns.entries()) {
    for (const [to, next] of columns.entries()) {
      if (from === to) continue;
      const { router, writes } = fixture();
      router.sprintTasks = {
        prepare: async (source, sprint) => {
          assert.equal(sprint.id, lists[to].id);
          return { changed: true, action: 'sync', moving: true };
        },
        apply: async plan => plan
      };
      const source = task(next, lists[from].name);
      source.start_date = lists[from].start_date;
      source.due_date = lists[from].due_date;
      const result = await router.reconcileTask(source, { changes: [statusChange(next, previous)] });
      assert.equal(result.assignedSprint, lists[to].name);
      assert.equal(result.targetStatus, next);
      assert.deepEqual(writes, [
        ['field', 'task', 'assigned', lists[to].name],
        ['task', 'task', {
          start_date: Number(lists[to].start_date), start_date_time: true,
          due_date: Number(lists[to].due_date), due_date_time: true
        }]
      ]);
    }
  }
});

test('READY TO SCHEDULE explicitly clears assignment/dates from every sprint; preview is read-only', async () => {
  for (const [index, previous] of ['sprint 0', 'sprint +1', 'sprint +2'].entries()) {
    const { router, writes } = fixture();
    router.sprintTasks = {
      prepare: async (source, sprint) => {
        assert.equal(sprint, null);
        assert.deepEqual(writes, []);
        return { changed: true, action: 'archive' };
      },
      apply: async plan => plan
    };
    const source = task('ready to schedule', lists[index].name);
    source.start_date = lists[index].start_date;
    source.due_date = lists[index].due_date;
    const original = JSON.stringify(source);
    const changes = [statusChange('ready to schedule', previous)];
    const preview = await router.reconcileTask(source, { changes, dryRun: true });
    assert.equal(preview.sprintTask.action, 'archive');
    assert.equal(preview.assignment.value, null);
    assert.equal(JSON.stringify(source), original);
    assert.deepEqual(writes, []);
    const applied = await router.reconcileTask(source, { changes });
    assert.equal(applied.assignedSprint, null);
    assert.equal(source.custom_fields[1].value, null);
    assert.deepEqual(writes, [
      ['clear', 'task', 'assigned'],
      ['task', 'task', { start_date: null, due_date: null }]
    ]);
  }
});

test('failed archive can be retried after assignment/dates were already cleared without recreating a task', async () => {
  const { router, writes } = fixture();
  let attempts = 0;
  router.sprintTasks = {
    prepare: async (source, sprint) => {
      assert.equal(sprint, null);
      return { changed: true, action: 'archive', itemId: 'existing-item' };
    },
    apply: async plan => {
      attempts += 1;
      if (attempts === 1) throw new Error('Archive request failed');
      return plan;
    }
  };
  const source = task('ready to schedule', lists[0].name);
  source.start_date = lists[0].start_date;
  source.due_date = lists[0].due_date;
  await assert.rejects(router.reconcileTask(source, {
    changes: [statusChange('ready to schedule', 'sprint 0')]
  }), /Archive request failed/);
  assert.equal(source.custom_fields[1].value, null);
  const before = writes.length;
  const retry = await router.reconcileTask(source);
  assert.equal(retry.sprintTask.itemId, 'existing-item');
  assert.equal(writes.length, before);
  assert.equal(attempts, 2);
});

test('daily reconciliation repairs protected task metadata without changing workflow status', async () => {
  const { router, client, writes } = fixture();
  client.getListTasks = async () => [task('in testing', lists[0].name)];
  client.getTask = async () => task('in testing', lists[0].name);
  let applied = false;
  router.sprintTasks = {
    prepare: async (source, sprint, catalog, options) => {
      assert.equal(options.allowCreate, false);
      return { changed: true, action: 'sync' };
    },
    apply: async plan => { applied = true; return plan; }
  };
  const result = await router.reconcileBacklog();
  assert.equal(result.evaluated, 1);
  assert.equal(applied, true);
  assert.deepEqual(writes, []);
});

test('stale status events and replaced input fields cannot schedule a task', async () => {
  const { router, writes } = fixture();
  const stale = await router.reconcileTask(task('ready to schedule'), {
    changes: [statusChange('sprint +2')]
  });
  assert.equal(stale.outcome, 'skipped');
  const changedField = await router.reconcileTask(task(), {
    changes: [{ ...assignedChange(null), custom_field: { id: 'old-field', name: 'Assigned Sprint' } }]
  });
  assert.equal(changedField.outcome, 'skipped');
  const staleAssignment = await router.reconcileTask(task('sprint +2', lists[2].name), {
    changes: [assignedChange(null)]
  });
  assert.equal(staleAssignment.outcome, 'skipped');
  assert.deepEqual(writes, []);
});

test('recorded completion works before the end date, without guessing from archive or time', async () => {
  const { router } = fixture({ completed: ['1'] });
  const result = await router.reconcileTask(task('sprint 0', lists[0].name));
  assert.equal(result.targetStatus, 'in testing');
});

test('partial scheduling failures surface and can recover through assignment reconciliation', async () => {
  const { router, client, writes } = fixture();
  const update = client.updateTask;
  client.updateTask = async () => { throw new Error('test task date update failed'); };
  const item = task('sprint +1');
  await assert.rejects(router.reconcileTask(item, {
    changes: [statusChange('sprint +1')]
  }), /test task date update failed/);
  assert.equal(item.custom_fields[1].value, lists[1].name);
  assert.equal(item.start_date, undefined);
  client.updateTask = update;
  const result = await router.reconcileTask(item, { changes: [assignedChange(lists[1].name)] });
  assert.equal(result.outcome, 'updated');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], ['task', 'task', {
    start_date: Number(lists[1].start_date), start_date_time: true,
    due_date: Number(lists[1].due_date), due_date_time: true
  }]);
});

test('before the first sprint or between sprints, SPRINT 0 is the next sprint to start', async t => {
  const gapLists = [lists[0], { ...lists[1], start_date: String(Number(lists[1].start_date) + 86400000) }, lists[2]];
  const cases = [
    { now: Date.parse('2026-11-10T12:00:00Z'), status: 'sprint 0', expected: lists[0].name },
    { now: Date.parse('2026-11-10T12:00:00Z'), status: 'sprint +1', expected: lists[1].name },
    { now: Number(lists[0].due_date) + 3600000, status: 'sprint 0', expected: lists[1].name },
    { now: Number(lists[0].due_date) + 3600000, status: 'sprint +1', expected: lists[2].name }
  ];
  for (const { now, status, expected } of cases) {
    await t.test(`${new Date(now).toISOString()} ${status}`, async () => {
      const { router } = fixture({ now, sprintLists: gapLists });
      const plan = await router.reconcileTask(task(status), { changes: [statusChange(status)], dryRun: true });
      assert.equal(plan.assignment.value, expected);
    });
  }
});

test('missing targets, dates, current sprints and unknown assignments fail before writing', async t => {
  const cases = [
    { options: { sprintLists: lists.slice(0, 2) }, item: task('sprint +2'), changes: [statusChange('sprint +2')] },
    { options: { taskStatuses: statuses.filter(status => status !== 'ready to schedule') }, item: task() },
    { options: { sprintLists: [{ ...lists[0], start_date: null }] }, item: task() },
    { options: { now: Date.parse('2027-01-02T12:00:00Z') }, item: task('sprint +1'), changes: [statusChange('sprint +1')] },
    { options: {}, item: task('new backlog', 'renamed-or-missing-sprint') },
    { options: { completed: ['nonexistent'] }, item: task() }
  ];
  for (const [index, scenario] of cases.entries()) {
    await t.test(`case ${index}`, async () => {
      const { router, writes } = fixture(scenario.options);
      await assert.rejects(router.reconcileTask(scenario.item, { changes: scenario.changes }));
      assert.deepEqual(writes, []);
    });
  }
  assert.throws(() => buildCatalog([lists[0], { ...lists[1], start_date: lists[0].start_date }], [], statuses), /overlap/);
});

test('read-only preview plans changes but cannot write or mutate task snapshots', async () => {
  const { router, writes } = fixture();
  const item = task('sprint +2');
  const original = JSON.stringify(item);
  const result = await router.reconcileTask(item, {
    changes: [statusChange('sprint +2')], dryRun: true
  });
  assert.equal(result.outcome, 'planned');
  assert.equal(result.assignment.value, lists[2].name);
  assert.equal(JSON.stringify(item), original);
  assert.deepEqual(writes, []);
});

test('daily check uses fresh task state and the same resolver, never scheduling from column names', async () => {
  const { router, client, writes } = fixture({ now: Date.parse('2026-11-30T05:00:00Z') });
  const assignedTask = task('sprint +1', lists[1].name);
  assignedTask.start_date = lists[1].start_date;
  assignedTask.due_date = lists[1].due_date;
  client.getListTasks = async () => [assignedTask, { ...task('complete'), id: 'done' }];
  const reads = [];
  client.getTask = async id => { reads.push(id); return assignedTask; };
  const preview = await router.reconcileBacklog({ dryRun: true });
  assert.equal(preview.scanned, 2);
  assert.equal(preview.plans[0].targetStatus, 'sprint 0');
  assert.equal(preview.plans[0].assignment, null);
  assert.deepEqual(reads, ['task']);
  assert.deepEqual(writes, []);
});

test('per-task serialization survives failures and protects other work on that task', async () => {
  const { router } = fixture();
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = router.withTaskLock('task', async () => {
    order.push('first');
    await gate;
    throw new Error('failed task operation');
  });
  const rejected = assert.rejects(first, /failed task operation/);
  const second = router.withTaskLock('task', async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  release();
  await Promise.all([rejected, second]);
  assert.deepEqual(order, ['first', 'second']);
});
