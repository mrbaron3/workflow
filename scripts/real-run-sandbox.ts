#!/usr/bin/env tsx
/**
 * Scaffold a grounded first run for the EXECUTION layer (ADR-0005 / _system/execution).
 *
 *   - .harness/sandbox/      a real git repo the agent edits (own tsconfig + vitest),
 *                            baseline-green except the target feature, which is missing.
 *   - test/acceptance/*.ts   a HARNESS-OWNED acceptance test = the independent grader
 *                            (protectedPaths); passing it is real evidence, not self-report.
 *   - a fresh store          with ONE issue in contract-drafted, assignedAgent = "claude"
 *                            (ai-managed → the scoping guard picks it up).
 *   - config                 generator: claude + target (real tsc/vitest graders).
 *
 * The graders are the harness's OWN tsc/vitest binaries run against the sandbox checkout,
 * so the sandbox needs no npm install. After scaffolding:  npx tsx scripts/real-run.ts
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { saveConfig, DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';

const ROOT = process.cwd();
const HARNESS = path.join(ROOT, '.harness');
const SANDBOX = path.join(HARNESS, 'sandbox');
const BIN = path.join(ROOT, 'node_modules', '.bin');

const write = (rel: string, content: string): void => {
  const abs = path.join(SANDBOX, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
};
const git = (args: string[]): void => void execFileSync('git', args, { cwd: SANDBOX, stdio: 'ignore' });

// --- clean slate -----------------------------------------------------------
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.rmSync(path.join(HARNESS, 'worktrees'), { recursive: true, force: true });
fs.rmSync(path.join(HARNESS, 'db.json'), { force: true });
fs.rmSync(path.join(HARNESS, 'evidence'), { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

// --- sandbox files ---------------------------------------------------------
write('package.json', JSON.stringify({ name: 'agentops-sandbox', version: '0.0.0', type: 'module', private: true }, null, 2) + '\n');
write(
  'tsconfig.json',
  JSON.stringify(
    { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022'], strict: true, skipLibCheck: true, noEmit: true }, include: ['src/**/*.ts', 'test/**/*.ts'] },
    null,
    2,
  ) + '\n',
);
write('.gitignore', 'node_modules/\n');
write('src/greet.ts', `export const greet = (name: string): string => \`hello, \${name}\`;\n`);
write(
  'test/greet.test.ts',
  `import { describe, it, expect } from 'vitest';
import { greet } from '../src/greet';
describe('greet (baseline)', () => {
  it('greets', () => { expect(greet('world')).toBe('hello, world'); });
});
`,
);
// Target feature ABSENT: src/roman.ts. The harness-owned acceptance test below fails at
// baseline; the agent's job is to make it pass. Titles carry the AC id for per-AC grounding.
write(
  'test/acceptance/roman.acceptance.test.ts',
  `import { describe, it, expect } from 'vitest';
import { toRoman, fromRoman } from '../../src/roman'; // implemented by the agent (absent at baseline)

describe('roman numerals', () => {
  it('AC-1 converts integers 1..3999 to roman numerals', () => {
    expect(toRoman(1)).toBe('I');
    expect(toRoman(4)).toBe('IV');
    expect(toRoman(9)).toBe('IX');
    expect(toRoman(58)).toBe('LVIII');
    expect(toRoman(1994)).toBe('MCMXCIV');
    expect(toRoman(3999)).toBe('MMMCMXCIX');
  });
  it('AC-2 parses roman numerals back to integers (round-trip)', () => {
    expect(fromRoman('MCMXCIV')).toBe(1994);
    for (const n of [1, 4, 9, 40, 90, 400, 900, 2024, 3888]) expect(fromRoman(toRoman(n))).toBe(n);
  });
  it('AC-3 rejects out-of-range and malformed input', () => {
    expect(() => toRoman(0)).toThrow();
    expect(() => toRoman(4000)).toThrow();
    expect(() => toRoman(3.5)).toThrow();
    expect(() => fromRoman('IIII')).toThrow();
    expect(() => fromRoman('ABC')).toThrow();
  });
});
`,
);

// --- git baseline ----------------------------------------------------------
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'sandbox@agentops.local']);
git(['config', 'user.name', 'agentops-sandbox']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'baseline: greet + failing roman acceptance test']);

// --- fresh store + one ai-managed issue ------------------------------------
const store = new Store(ROOT);
const issueId = store.nextId('ISSUE');
store.addIssue(
  Issue.parse({
    id: issueId,
    type: 'story',
    title: 'Roman numeral converter (toRoman / fromRoman)',
    area: 'backend',
    status: 'contract-drafted',
    assignedAgent: 'claude', // ai-managed → scoping guard picks it up
    createdAt: nowISO(),
    updatedAt: nowISO(),
    contract: {
      productGoal: 'A dependable roman-numeral conversion utility.',
      userStory: 'As a developer I want toRoman/fromRoman to convert between integers and roman numerals with validation.',
      scope: { include: ['src/**'], exclude: ['test/acceptance/**'] },
      acceptanceCriteria: [
        { id: 'AC-1', severity: 'blocker', behavior: 'toRoman(n) converts an integer in 1..3999 to its roman numeral.', verification: { method: 'unit_test', expected: ['toRoman(1994) === "MCMXCIV"', 'toRoman(3999) === "MMMCMXCIX"'] } },
        { id: 'AC-2', severity: 'blocker', behavior: 'fromRoman(s) parses a roman numeral back to its integer (round-trips).', verification: { method: 'unit_test', expected: ['fromRoman("MCMXCIV") === 1994', 'fromRoman(toRoman(n)) === n'] } },
        { id: 'AC-3', severity: 'major', behavior: 'Out-of-range or malformed input is rejected by throwing.', verification: { method: 'unit_test', expected: ['toRoman(0) throws', 'toRoman(4000) throws', 'fromRoman("IIII") throws'] } },
      ],
      redLines: [
        'Do not modify anything under test/acceptance/** — it is the independent grader.',
        'Do not hardcode outputs for the specific test inputs; implement the general algorithm.',
      ],
    },
  }),
);
store.save();

// --- config: real backend + real graders -----------------------------------
// maxRepairs bounds the live repair loop (attempts = maxRepairs + 1). Default 0 = one attempt
// (cheapest grounded run). Raise it to watch live repair: on a lens's request_changes the harness
// feeds the findings back into the next generator session. e.g.  MAX_REPAIRS=1 npx tsx scripts/real-run-sandbox.ts
const config: HarnessConfig = {
  ...DEFAULT_CONFIG,
  generator: 'claude',
  samples: 1,
  maxRepairs: process.env.MAX_REPAIRS ? Number(process.env.MAX_REPAIRS) : 0,
  target: {
    repo: '.harness/sandbox',
    baseRef: 'HEAD',
    graders: {
      typecheck: `${path.join(BIN, 'tsc')} --noEmit -p tsconfig.json`,
      unit_tests: `${path.join(BIN, 'vitest')} run`,
    },
    protectedPaths: ['test/acceptance/'],
  },
};
saveConfig(ROOT, config);

console.log(`✓ scaffolded sandbox at ${path.relative(ROOT, SANDBOX)}`);
console.log(`✓ seeded ${issueId} (contract-drafted, assignedAgent=claude) + config (grounded target)`);
console.log(`\nNext:  npx tsx scripts/real-run.ts`);
