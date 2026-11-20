const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originFromLine, syncWebhook } = require('../scripts/sync-dev-webhook');

const origin = 'https://new-example.trycloudflare.com';
const hook = {
  id: 'existing', endpoint: 'https://old-example.trycloudflare.com/webhook/clickup',
  health: { status: 'suspended' }, secret: 'test-secret', space_id: 123,
  events: ['taskUpdated', 'taskStatusUpdated']
};

test('detects the advertised Quick Tunnel origin but not a lookalike or a health URL', () => {
  assert.equal(originFromLine(`2026-11-20T15:02:44Z INF |  ${origin}  |`), origin);
  assert.equal(originFromLine(`INF | ${origin}.example.com |`), undefined);
  assert.equal(originFromLine(`Checking ${origin}/health`), undefined);
});

test('updates the existing webhook and reactivates it without changing its subscription', async t => {
  let webhooks = [{ ...hook, id: 'unrelated', secret: 'other-secret' }, hook];
  const client = {
    get: t.mock.fn(async () => ({ data: { webhooks } })),
    put: t.mock.fn(async (_path, updates) => {
      webhooks = [webhooks[0], { ...hook, ...updates, health: { status: updates.status } }];
    })
  };
  assert.equal(await syncWebhook(client, 'workspace', hook.secret, origin), 'updated and active');
  assert.deepEqual(client.put.mock.calls.map(call => call.arguments.slice(0, 2)), [[
    '/webhook/existing', { endpoint: `${origin}/webhook/clickup`, events: hook.events, status: 'active' }
  ]]);
  assert.equal(await syncWebhook(client, 'workspace', hook.secret, origin), 'already active');
  assert.equal(client.put.mock.callCount(), 1);
});

test('refuses to rewrite ambiguous webhooks or a webhook with a stable hostname', async t => {
  for (const [webhooks, error] of [
    [[hook, { ...hook, id: 'second' }], /exactly one/],
    [[{ ...hook, endpoint: 'https://webhooks.example.com/webhook/clickup' }], /not a Quick Tunnel/]
  ]) {
    const client = { get: async () => ({ data: { webhooks } }), put: t.mock.fn() };
    await assert.rejects(syncWebhook(client, 'workspace', hook.secret, origin), error);
    assert.equal(client.put.mock.callCount(), 0);
  }
});
