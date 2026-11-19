const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendHealthEmail } = require('../src/services/healthEmail');

const settings = {
  enabled: true, to: 'john@towpro.io', subject: 'Clickup Webhook Service is healthy',
  failureSubject: 'Clickup Webhook Service daily check FAILED', timeZone: 'America/New_York'
};
const env = { SMTP_USER: 'sender@towpro.io' };
const result = {
  scanned: 4, evaluated: 2, plans: [{ outcome: 'updated' }, { outcome: 'skipped' }],
  sprintCreation: { dryRun: false, planned: ['Sprint 4 (1/4 - 1/17)'], created: [{ id: 'l', name: 'Sprint 4 (1/4 - 1/17)' }] }
};
const capture = () => {
  const sent = [];
  return { sent, transport: { sendMail: async message => { sent.push(message); } } };
};

test('a successful daily check sends the healthy subject with its results', async () => {
  const { sent, transport } = capture();
  assert.equal(await sendHealthEmail(settings, { result }, { transport, env }), true);
  assert.equal(sent[0].to, 'john@towpro.io');
  assert.equal(sent[0].from, 'sender@towpro.io');
  assert.equal(sent[0].subject, 'Clickup Webhook Service is healthy');
  assert.match(sent[0].text, /Tasks updated: 1/);
  assert.match(sent[0].text, /Sprints created: Sprint 4 \(1\/4 - 1\/17\)/);
});

test('a failed check or failed sprint creation sends the failure subject', async () => {
  const { sent, transport } = capture();
  await sendHealthEmail(settings, { error: new Error('ClickUp unavailable') }, { transport, env });
  await sendHealthEmail(settings, {
    result: { ...result, sprintCreation: { planned: [], created: [], error: 'bad dates' } }
  }, { transport, env });
  assert.deepEqual(sent.map(message => message.subject), [settings.failureSubject, settings.failureSubject]);
  assert.match(sent[0].text, /FAILED: ClickUp unavailable/);
  assert.match(sent[1].text, /Sprint creation FAILED: bad dates/);
});

test('send errors are reported as false instead of throwing', async () => {
  const transport = { sendMail: async () => { throw new Error('auth failed'); } };
  assert.equal(await sendHealthEmail(settings, { result }, { transport, env }), false);
});
