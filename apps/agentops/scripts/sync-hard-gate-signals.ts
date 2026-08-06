import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARD_GATE_SIGNAL_NAMES } from '../src/graders/gate-names.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  scriptDirectory,
  '../../control-plane/internal/control/hard_gate_signal_names.generated.json',
);
const rendered = `${JSON.stringify(HARD_GATE_SIGNAL_NAMES, null, 2)}\n`;
const check = process.argv.includes('--check');

if (check) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== rendered) {
    console.error('hard gate signal mirror is stale; run npm run sync-hard-gates');
    process.exitCode = 1;
  } else {
    console.log('hard gate signal mirror is up to date');
  }
} else {
  fs.writeFileSync(target, rendered);
  console.log(`updated ${path.relative(process.cwd(), target)}`);
}
