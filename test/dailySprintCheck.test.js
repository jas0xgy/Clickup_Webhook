const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DailySprintCheck } = require('../src/services/dailySprintCheck');

const config = { timeZone: 'America/New_York', hour: 0, minute: 5 };

test('daily check runs at 00:05 New York time, once per date, across DST changes', async () => {
  let current = new Date('2026-10-31T12:00:00Z');
  let runs = 0;
  const check = new DailySprintCheck(async () => { runs += 1; }, config, () => current);
  current = new Date('2026-11-01T04:04:59Z');
  assert.equal(await check.tick(), false);
  current = new Date('2026-11-01T04:05:00Z');
  assert.equal(await check.tick(), true);
  assert.equal(await check.tick(), false);
  current = new Date('2026-11-02T05:04:59Z');
  assert.equal(await check.tick(), false);
  current = new Date('2026-11-02T05:05:00Z');
  assert.equal(await check.tick(), true);
  assert.equal(runs, 2);
});

test('starting after check time does not cause a surprise bulk update', async () => {
  let current = new Date('2026-11-17T21:00:00Z');
  let runs = 0;
  const check = new DailySprintCheck(async () => { runs += 1; }, config, () => current);
  assert.equal(await check.tick(), false);
  current = new Date('2026-11-18T05:05:00Z');
  assert.equal(await check.tick(), true);
  assert.equal(runs, 1);
});

test('overlapping ticks cannot launch a second run and failures are surfaced', async () => {
  let current = new Date('2026-11-17T05:00:00Z');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const check = new DailySprintCheck(async () => {
    await gate;
    throw new Error('daily reconciliation failed');
  }, config, () => current);
  current = new Date('2026-11-17T05:05:00Z');
  const running = check.tick();
  assert.equal(await check.tick(), false);
  const rejected = assert.rejects(running, /daily reconciliation failed/);
  release();
  await rejected;
  assert.equal(check.running, false);
});
