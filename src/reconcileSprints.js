require('dotenv').config();

const { reconcileSprints } = require('./services/webhookHandler');

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) ||
      (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: node src/reconcileSprints.js [--dry-run | --apply]');
  }
  const result = await reconcileSprints({ dryRun: !args.includes('--apply') });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(`Sprint reconciliation failed: ${error.message}`);
  if (error instanceof AggregateError) {
    for (const failure of error.errors) console.error(failure.message);
  }
  process.exitCode = 1;
});
