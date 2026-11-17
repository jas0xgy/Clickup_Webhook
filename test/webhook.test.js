const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

test('server verifies webhook signatures against the original request bytes', {
  timeout: 15000
}, async () => {
  const secret = 'local-test-secret';
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', CLICKUP_WEBHOOK_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  let output = '';
  const timer = setTimeout(() => child.kill(), 12000);

  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/listening on port (\d+)/);
        if (match) resolve(match[1]);
      });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.ok(Number.isFinite(Date.parse(healthBody.timestamp)));

    // Unknown events exercise authentication without calling the ClickUp API.
    const body = '{\n  "event": "localTest", "task_id": "test"\n}';
    const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
    const post = signature => fetch(`${base}/webhook/clickup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature === undefined ? {} : { 'X-Signature': signature })
      },
      body
    });

    const accepted = await post(sign(body));
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).success, true);

    for (const signature of [
      undefined,
      'not-a-signature',
      'a'.repeat(64),
      sign(JSON.stringify(JSON.parse(body)))
    ]) {
      const rejected = await post(signature);
      assert.equal(rejected.status, 401);
      assert.deepEqual(await rejected.json(), { error: 'Invalid signature' });
    }
  } finally {
    clearTimeout(timer);
    child.kill();
    await closed;
  }
});
