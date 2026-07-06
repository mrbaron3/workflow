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
 * so the sandbox needs no npm install. After scaffolding:  npx tsx scripts/real-panel-run.ts
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
fs.rmSync(path.join(HARNESS, 'review-worktrees'), { recursive: true, force: true }); // kept-alive stuck reviews
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
//
// HARD=1 turns this into a repair-BAIT run (to observe the live repair loop): AC-3's strict cases
// — lowercase, whitespace-padded, and internal-space input must be REJECTED — live only in this
// acceptance test, NOT in the contract's AC-3 (which just says "reject malformed input"). A
// first-pass generator that normalises input (trim/toUpperCase, a common "be lenient" choice) will
// wrongly ACCEPT them and fail AC-3 → request_changes → a repair brief → attempt 2, which (now
// failing) tends to read the grader and tighten to strict rejection. Probabilistic, not guaranteed:
// a generator that chooses strict parsing from the start passes on attempt 1 (see the handoff).
const HARD = !!process.env.HARD;
const ac3Strict = HARD
  ? `  it('AC-3 rejects out-of-range, non-integer, and every malformed/non-strict roman string', () => {
    for (const bad of [0, -1, 4000, 3.5, NaN, Infinity]) expect(() => toRoman(bad as number)).toThrow();
    // STRICT: no normalisation — case, surrounding/internal whitespace, and non-canonical forms all throw
    for (const bad of ['', 'iv', 'McMxciv', ' IV', 'IV ', 'I V', 'IIII', 'VV', 'IL', 'IC', 'XM', 'IXIX'])
      expect(() => fromRoman(bad)).toThrow();
  });`
  : `  it('AC-3 rejects out-of-range and malformed input', () => {
    expect(() => toRoman(0)).toThrow();
    expect(() => toRoman(4000)).toThrow();
    expect(() => toRoman(3.5)).toThrow();
    expect(() => fromRoman('IIII')).toThrow();
    expect(() => fromRoman('ABC')).toThrow();
  });`;
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
${ac3Strict}
});
`,
);

// --- system design views (exercise the scoped-context assembler, ARCH-execution-007) ------
// A small `_system` layer the issue references via dependsOnSystem. config.target.systemDir points
// here, so the generator prompt gets these design elements resolved (id refs, never copied). Two
// conventions on purpose: DOM/ARCH as bullets, LANG as a table row (mirrors the harness's own views).
write(
  'docs/specs/_system/roman/domain-model.md',
  `# Roman numerals — domain

- **DOM-roman-001 Value range** — a roman numeral represents an integer in the closed range 1..3999; there is no zero and nothing outside this range is representable. Out-of-range input is rejected.
- **DOM-roman-002 Canonical subtractive form** — the canonical encoding uses the six subtractive pairs (IV=4, IX=9, XL=40, XC=90, CD=400, CM=900). A run of four equal symbols (IIII, XXXX) is NOT canonical: \`toRoman\` must never emit one and \`fromRoman\` must reject one.
`,
);
write(
  'docs/specs/_system/roman/ubiquitous-language.md',
  `# Roman numerals — ubiquitous language

| id | term | meaning |
|---|---|---|
| LANG-roman-001 | round-trip | \`fromRoman(toRoman(n)) === n\` for every n in range; the two functions are exact inverses on canonical forms. |
`,
);
write(
  'docs/specs/_system/roman/architecture.md',
  `# Roman numerals — architecture

- **ARCH-roman-001 Pure total functions** — \`toRoman\`/\`fromRoman\` are pure (no I/O, no globals) and total over their domain: valid input returns a value, invalid input throws — never returns null/NaN/empty or silently coerces.
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
    // Referenced design (ARCH-execution-007): the generator prompt resolves these from systemDir.
    dependsOnSystem: ['DOM-roman-001', 'DOM-roman-002', 'LANG-roman-001', 'ARCH-roman-001'],
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
    // scoped-context source (ARCH-execution-007): the issue's dependsOnSystem resolve from here.
    systemDir: '.harness/sandbox/docs/specs/_system',
  },
};
saveConfig(ROOT, config);

console.log(`✓ scaffolded sandbox at ${path.relative(ROOT, SANDBOX)}${HARD ? ' [HARD: repair-bait acceptance test]' : ''}`);
console.log(`✓ seeded ${issueId} (contract-drafted, assignedAgent=claude) + config (grounded target, maxRepairs=${config.maxRepairs})`);
console.log(`\nNext:  LENSES=codeQuality npx tsx scripts/real-panel-run.ts   (cheap: generator + 1 review)`);
if (HARD) console.log(`       (HARD run: attempt 1 may fail AC-3 → watch the repair loop drive attempt 2)`);
