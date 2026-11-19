require('dotenv').config();

const { reconcileSprints } = require('./services/webhookHandler');
const { sendHealthEmail } = require('./services/healthEmail');
const { sprintRouting } = require('./config');

// Sends the daily health email now, using a read-only preview so nothing in ClickUp changes.
async function main() {
  const note = 'Manual test send (preview only; no ClickUp changes were made).';
  let outcome;
  try {
    outcome = { result: await reconcileSprints({ dryRun: true }), note };
  } catch (error) {
    outcome = { error, note };
  }
  if (!await sendHealthEmail(sprintRouting.healthEmail, outcome)) process.exitCode = 1;
}

main();
