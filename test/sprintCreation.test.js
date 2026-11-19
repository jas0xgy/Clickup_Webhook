const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog } = require('../src/services/sprintRouting');
const { SprintCreation, planSprints } = require('../src/services/sprintCreation');

const lists = [
  { id: 's1', name: 'Sprint 1 (11/23 - 12/6)', start_date: '1795410000000', due_date: '1796619599999' },
  { id: 's2', name: 'Sprint 2 (12/7 - 12/20)', start_date: '1796619600000', due_date: '1797829199999' },
  { id: 's3', name: 'Sprint 3 (12/21 - 1/3)', start_date: '1797829200000', due_date: '1799038799999' }
];
const catalog = () => buildCatalog(structuredClone(lists), [], []);
const options = { futureCount: 3, timeZone: 'America/New_York' };

test('no sprint is planned while three sprints start after today', () => {
  assert.deepEqual(planSprints(catalog(), Date.parse('2026-11-18T20:00:00Z'), options), []);
});

test('once a sprint starts, the next consecutive sprint is planned with local-midnight dates', () => {
  const [next, ...rest] = planSprints(catalog(), Date.parse('2026-11-24T15:00:00Z'), options);
  assert.equal(rest.length, 0);
  assert.equal(next.name, 'Sprint 4 (1/4 - 1/17)');
  assert.equal(next.start, Date.parse('2027-01-04T05:00:00Z'));
  assert.equal(next.end, Date.parse('2027-01-18T04:59:59.999Z'));
});

test('gaps are filled sequentially and dates stay at local midnight across daylight saving', () => {
  const planned = planSprints(catalog(), Date.parse('2027-02-20T15:00:00Z'), options);
  assert.deepEqual(planned.map(sprint => sprint.name), [
    'Sprint 4 (1/4 - 1/17)', 'Sprint 5 (1/18 - 1/31)', 'Sprint 6 (2/1 - 2/14)', 'Sprint 7 (2/15 - 2/28)',
    'Sprint 8 (3/1 - 3/14)', 'Sprint 9 (3/15 - 3/28)', 'Sprint 10 (3/29 - 4/11)'
  ]);
  assert.equal(planned[5].start, Date.parse('2027-03-15T04:00:00Z'));
  assert.equal(planned[4].end, Date.parse('2027-03-15T03:59:59.999Z'));
});

test('dry runs report the plan without creating; applied runs create and verify the Lists', async () => {
  const created = [];
  const clickup = {
    createList: async (folderId, list) => {
      created.push([folderId, list]);
      return { id: 'new', start_date: String(list.start_date), due_date: String(list.due_date) };
    }
  };
  const config = { sprintFolderId: 'folder', sprintCreation: { enabled: true, futureSprints: 3 },
    daily: { timeZone: 'America/New_York' } };
  const routing = { loadCatalog: async () => catalog() };
  const service = new SprintCreation(clickup, config, routing, () => Date.parse('2026-11-24T15:00:00Z'));
  assert.deepEqual((await service.ensureFutureSprints({ dryRun: true })).planned, ['Sprint 4 (1/4 - 1/17)']);
  assert.equal(created.length, 0);
  const result = await service.ensureFutureSprints();
  assert.deepEqual(result.created, [{ id: 'new', name: 'Sprint 4 (1/4 - 1/17)' }]);
  assert.equal(created[0][0], 'folder');
});
