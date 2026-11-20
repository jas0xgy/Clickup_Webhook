const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

const quickTunnelOrigin = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const webhookPath = '/webhook/clickup';

function originFromLine(line) {
  return line.match(/\|\s+(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s+\|/)?.[1];
}

async function syncWebhook(client, workspaceId, secret, origin) {
  if (!quickTunnelOrigin.test(origin)) throw new Error('Expected a Cloudflare Quick Tunnel HTTPS URL.');
  if (!secret || secret === 'your_webhook_secret_here') {
    throw new Error('Set CLICKUP_WEBHOOK_SECRET before syncing the webhook.');
  }

  const endpoint = `${origin}${webhookPath}`;
  const list = async () => {
    const { data } = await client.get(`/team/${workspaceId}/webhook`, { maxRedirects: 0 });
    if (!Array.isArray(data.webhooks)) throw new Error('ClickUp returned an invalid webhook list.');
    return data.webhooks;
  };
  const hooks = (await list()).filter(hook => hook.secret === secret);
  if (hooks.length !== 1) {
    throw new Error('Expected exactly one ClickUp webhook matching CLICKUP_WEBHOOK_SECRET; no webhook was changed.');
  }
  const [hook] = hooks;
  if (!hook.endpoint?.endsWith(webhookPath) ||
      !quickTunnelOrigin.test(hook.endpoint.slice(0, -webhookPath.length))) {
    throw new Error('The matching webhook is not a Quick Tunnel webhook; refusing to replace its endpoint.');
  }
  if (hook.endpoint === endpoint && hook.health?.status === 'active') return 'already active';
  if (!hook.id || !Array.isArray(hook.events) || hook.events.length === 0) {
    throw new Error('Missing ClickUp webhook ID or event subscription; no webhook was changed.');
  }

  await client.put(`/webhook/${encodeURIComponent(hook.id)}`, {
    endpoint, events: hook.events, status: 'active'
  }, { maxRedirects: 0 });
  const updated = (await list()).find(candidate => candidate.id === hook.id);
  if (updated?.endpoint !== endpoint || updated.health?.status !== 'active' || updated.secret !== secret ||
      ['space_id', 'folder_id', 'list_id', 'task_id'].some(key => updated[key] !== hook[key]) ||
      !Array.isArray(updated.events) ||
      JSON.stringify([...updated.events].sort()) !== JSON.stringify([...hook.events].sort())) {
    throw new Error('ClickUp did not confirm an active webhook with the expected endpoint, scope, events, and secret.');
  }
  return 'updated and active';
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 90_000;
  do {
    try {
      const response = await fetch(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(3_000) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch (error) {
      if (!['TypeError', 'SyntaxError', 'TimeoutError'].includes(error.name)) throw error;
    }
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error('The public /health endpoint did not become ready; ClickUp was not changed.');
}

async function main(origin) {
  const tunnelEnv = { ...process.env };
  for (const key of Object.keys(tunnelEnv)) {
    if (/^(CLICKUP_|GMAIL_|SMTP_)/i.test(key)) delete tunnelEnv[key];
  }
  require('dotenv').config();
  const { ClickUpClient } = require('../src/services/clickupClient');
  const { sprintRouting } = require('../src/config');

  async function sync(url) {
    if (!quickTunnelOrigin.test(url)) throw new Error('Expected a Cloudflare Quick Tunnel HTTPS URL.');
    console.log(`Checking ${url}/health before updating ClickUp...`);
    await waitForHealth(url);
    const result = await syncWebhook(new ClickUpClient().client, sprintRouting.workspaceId,
      process.env.CLICKUP_WEBHOOK_SECRET, url);
    console.log(`ClickUp webhook ${result}: ${url}${webhookPath}`);
  }

  if (origin !== undefined) return sync(origin);
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dev service PORT.');
  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { env: tunnelEnv });
  tunnel.on('error', reportError);
  tunnel.on('exit', (code, signal) => {
    if (!signal && code !== 0) reportError(new Error(`cloudflared exited with code ${code}.`));
  });
  let detected;
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      console.log(line);
      const url = originFromLine(line);
      if (!detected && url) {
        detected = url;
        sync(detected).catch(reportError);
      }
    });
  }
}

function reportError(error) {
  // Never dump Axios errors or configs, which can include the API token.
  console.error(`Dev webhook setup failed: ${error.response?.status ? `ClickUp HTTP ${error.response.status}` : error.message}`);
  process.exitCode = 1;
}

if (require.main === module) main(process.argv[2]).catch(reportError);
module.exports = { originFromLine, syncWebhook };
