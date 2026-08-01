import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  EvalRun,
  GithubIssueSnapshot,
  PR,
  type CapabilityReconciliationInput,
  type DesignRequest,
  type Issue,
} from '../src/domain/schema.js';
import {
  evaluateDesignflowReleaseLineage,
} from '../src/designflow/release-lineage.js';
import {
  createDesignflowContractConsumer,
} from '../src/designflow/contract-consumer.js';
import {
  runGithubDevelopmentTurn,
  type DesignflowCapabilityReconcilerInput,
} from '../src/intake/development-turn.js';
import {
  githubIntakeKey,
  type GithubIssueRunner,
} from '../src/intake/github-issues.js';
import {
  resumeDesignPlanningAfterRequestChanges,
} from '../src/intake/planning-enrichment.js';
import { PERSPECTIVES } from '../src/pipeline/panel.js';
import {
  autoMergeCurrentRevision,
  observePrRevision,
  type PrNativeGithubRunner,
} from '../src/pipeline/execution/pr-native.js';
import { Store } from '../src/store/store.js';
import {
  createGenericBundleFixture,
  GENERIC_CAPABILITY_IDS,
  GENERIC_DECISION_IDS,
  GENERIC_REVISION_IDS,
  type GenericBundleFixture,
} from './helpers/designflow-grounded-fixture.js';

const roots: string[] = [];
const REPOSITORY = 'acme/reporting';
const CANDIDATE_KEY = 'report-workspace';
const SOURCE_NUMBER = 73;
const HEAD_SHA = createHash('sha1')
  .update('generic-report-workspace-approved-implementation')
  .digest('hex');
const API_HEAD_SHA = createHash('sha1')
  .update('generic-report-api-approved-implementation')
  .digest('hex');
const WRONG_SUPERSEDES_DECISION_ID = 'unrelated-request-changes-decision';

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function createRoot(): { root: string; systemDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designflow-standard-intake-'));
  roots.push(root);
  const systemDir = path.join(root, 'docs', '_system');
  fs.mkdirSync(path.join(systemDir, 'reporting'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, 'reporting', 'design.md'),
    [
      '# Reporting system',
      '',
      '- **DOM-report-001 Report workspace** — Presents the current report and export feedback.',
      '- **ARCH-report-001 Report API** — Owns summary reads and idempotent export commands.',
      '',
    ].join('\n'),
    'utf8',
  );
  return { root, systemDir };
}

function sourceSnapshot() {
  return GithubIssueSnapshot.parse({
    repository: REPOSITORY,
    number: SOURCE_NUMBER,
    externalId: 'I_REPORT_73',
    title: 'Add an accessible report workspace',
    body: [
      'Analysts need to view the current report summary.',
      'They must export the current report without leaving the workspace.',
      'The UI must provide keyboard and screen-reader feedback.',
    ].join(' '),
    url: `https://example.test/${REPOSITORY}/issues/${SOURCE_NUMBER}`,
    labels: ['ready'],
    state: 'open',
    sourceUpdatedAt: '2026-07-28T03:00:00.000Z',
    snapshotAt: '2026-07-28T03:01:00.000Z',
  });
}

function designDraft() {
  return {
    candidateKey: CANDIDATE_KEY,
    title: 'Design and implement the report workspace',
    type: 'feature' as const,
    area: 'fullstack' as const,
    productIntent: {
      primaryOutcome: 'Analysts understand and export the current report in one workspace',
      users: ['Analysts'],
      usageContext: 'While reviewing the current report in a web browser',
    },
    requirements: [
      {
        id: 'REQ-REPORT-001',
        statement: 'Analysts can view the current report summary',
        priority: 'blocker' as const,
      },
      {
        id: 'REQ-REPORT-002',
        statement: 'Analysts can export the current report',
        priority: 'blocker' as const,
      },
      {
        id: 'REQ-REPORT-003',
        statement: 'The workspace provides keyboard and screen-reader feedback',
        priority: 'major' as const,
      },
    ],
    constraints: [{
      id: 'CON-REPORT-A11Y',
      category: 'accessibility' as const,
      statement: 'Keyboard focus and status announcements must remain observable',
    }],
    targetSurfaces: ['web' as const],
    existingDesignSystemRef: null,
    traces: [
      {
        requirementId: 'REQ-REPORT-001',
        sources: [
          { kind: 'source' as const, text: 'view the current report summary' },
          { kind: 'system' as const, elementId: 'DOM-report-001' },
        ],
      },
      {
        requirementId: 'REQ-REPORT-002',
        sources: [
          { kind: 'source' as const, text: 'export the current report' },
          { kind: 'system' as const, elementId: 'ARCH-report-001' },
        ],
      },
      {
        requirementId: 'REQ-REPORT-003',
        sources: [
          { kind: 'source' as const, text: 'keyboard and screen-reader feedback' },
          { kind: 'system' as const, elementId: 'DOM-report-001' },
        ],
      },
    ],
  };
}

function reconciledPlan(
  input: DesignflowCapabilityReconcilerInput,
): CapabilityReconciliationInput {
  const identity = {
    requestId: input.approvedContract.requestId,
    revisionId: input.approvedContract.revisionId,
    bundleDigest: input.approvedContract.bundleDigest,
  };
  return {
    schemaVersion: '1.0',
    ...identity,
    candidates: [
      {
        candidate: {
          candidateKey: 'report-api',
          title: 'Implement approved report API capabilities',
          type: 'feature',
          area: 'backend',
          contract: {
            productGoal: 'Provide the approved report summary and export capabilities',
            userStory: 'As an analyst, I can read and export the current report safely',
            scope: { include: ['src/reporting/api/**'], exclude: [] },
            acceptanceCriteria: [{
              id: 'AC-REPORT-API-001',
              severity: 'blocker',
              behavior: 'The report API owns summary reads and idempotent exports',
              verification: {
                method: 'api_test',
                expected: ['Both approved API operations are contract tested'],
              },
            }],
            redLines: ['Do not expose provider paths or credentials'],
            apiOperations: [
              {
                operationId: 'get-report-summary',
                method: 'GET',
                path: '/v1/reports/current',
                purpose: 'Read the current report summary',
              },
              {
                operationId: 'create-report-export',
                method: 'POST',
                path: '/v1/reports/current/exports',
                purpose: 'Start one idempotent report export',
              },
            ],
          },
          traces: [{
            criterionId: 'AC-REPORT-API-001',
            sources: [
              { kind: 'source', text: 'export the current report' },
              { kind: 'system', elementId: 'ARCH-report-001' },
            ],
          }],
        },
        dependsOnCandidateKeys: [],
      },
      {
        candidate: {
        candidateKey: CANDIDATE_KEY,
        title: 'Implement the approved report workspace',
        type: 'feature',
        area: 'fullstack',
        contract: {
          productGoal: 'Analysts understand and export the current report',
          userStory: 'As an analyst, I can inspect and export a report in one workspace',
          scope: { include: ['src/reporting/**'], exclude: [] },
          acceptanceCriteria: [
            {
              id: 'AC-REPORT-001',
              severity: 'blocker',
              behavior: 'The approved report workspace is keyboard operable',
              verification: {
                method: 'playwright',
                expected: ['Summary, export action, focus, and live feedback are observable'],
              },
            },
            {
              id: 'AC-REPORT-002',
              severity: 'blocker',
              behavior: 'The report summary and export API implement approved capabilities',
              verification: {
                method: 'api_test',
                expected: ['Summary read and export command have explicit operations'],
              },
            },
            {
              id: 'AC-REPORT-003',
              severity: 'major',
              behavior: 'Purpose, effort, attention, and element rationale remain traceable',
              verification: {
                method: 'unit_test',
                expected: ['The approved review projection is preserved'],
              },
            },
          ],
          redLines: ['Do not expose provider paths or credentials'],
        },
        traces: [
          {
            criterionId: 'AC-REPORT-001',
            sources: [
              { kind: 'source', text: 'keyboard and screen-reader feedback' },
              { kind: 'system', elementId: 'DOM-report-001' },
            ],
          },
          {
            criterionId: 'AC-REPORT-002',
            sources: [
              { kind: 'source', text: 'export the current report' },
              { kind: 'system', elementId: 'ARCH-report-001' },
            ],
          },
          {
            criterionId: 'AC-REPORT-003',
            sources: [
              { kind: 'source', text: 'view the current report summary' },
              { kind: 'system', elementId: 'DOM-report-001' },
            ],
          },
        ],
      },
        dependsOnCandidateKeys: ['report-api'],
      },
    ],
    bindings: [
      {
        capabilityId: 'cap-view-report-summary',
        ...identity,
        issueEdges: [{
          candidateKey: 'report-api',
          criterionId: 'AC-REPORT-API-001',
        }, {
          candidateKey: CANDIDATE_KEY,
          criterionId: 'AC-REPORT-001',
        }],
        systemElementIds: ['DOM-report-001', 'ARCH-report-001'],
        apiOperationIds: ['get-report-summary'],
      },
      {
        capabilityId: 'cap-export-report',
        ...identity,
        issueEdges: [{
          candidateKey: 'report-api',
          criterionId: 'AC-REPORT-API-001',
        }, {
          candidateKey: CANDIDATE_KEY,
          criterionId: 'AC-REPORT-002',
        }],
        systemElementIds: ['DOM-report-001', 'ARCH-report-001'],
        apiOperationIds: ['create-report-export'],
      },
    ],
    ambiguities: [],
  };
}

function config(systemDir: string): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    samples: 1,
    target: {
      repo: '.',
      systemDir,
    },
    gate: {
      backend: 'github',
      requiredChecks: ['ci'],
    },
    routes: {
      planning: { provider: 'mock' },
      generator: { provider: 'mock' },
      reviewer: { provider: 'mock' },
    },
    intake: {
      backend: 'github',
      repository: REPOSITORY,
      readyLabel: 'ready',
      claimedLabel: 'agent-claimed',
      designProviders: { [CANDIDATE_KEY]: 'designflow' },
    },
  };
}

class FakeGithubIssueRunner implements GithubIssueRunner {
  readonly snapshot = sourceSnapshot();
  readonly claims: number[] = [];

  listReadyIssues() {
    return [this.snapshot];
  }

  claimIssue(_repository: string, issueNumber: number): void {
    this.claims.push(issueNumber);
  }
}

class FakePrRunner implements PrNativeGithubRunner {
  readonly heads = new Map<number, string>();
  readonly merged = new Set<number>();
  mergeCalls: Array<{ number: number; head: string }> = [];
  closeCalls: Array<{ repository: string; number: number }> = [];

  register(number: number, head: string): void {
    this.heads.set(number, head);
  }

  viewRevision(_cwd: string, number: number) {
    const headSha = this.heads.get(number);
    if (!headSha) throw new Error(`unregistered fake PR ${number}`);
    return {
      state: this.merged.has(number) ? 'merged' as const : 'open' as const,
      headSha,
      isDraft: false,
      mergeability: 'mergeable' as const,
      checks: [{ name: 'ci', status: 'success' as const }],
      unresolvedBlockingThreadIds: [],
      blockingReviewThreads: [],
    };
  }

  merge(_cwd: string, number: number, expectedHeadSha: string): void {
    if (expectedHeadSha !== this.heads.get(number)) throw new Error('stale expected head');
    this.mergeCalls.push({ number, head: expectedHeadSha });
    this.merged.add(number);
  }

  closeIssue(_cwd: string, repository: string, number: number): void {
    this.closeCalls.push({ repository, number });
  }
}

function implementationHtml(issue: Issue): string {
  if (issue.designAuthority?.provider !== 'designflow' || !issue.designReview) {
    throw new Error('implementation evidence requires an approved Designflow Issue');
  }
  const purpose = String(issue.designReview.purposes[0]?.primaryPurpose ?? '');
  const rationale = String(issue.designReview.elements[3]?.placementRationale ?? '');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Report workspace</title><style>',
    '*{box-sizing:border-box}body{margin:0;background:#fff;color:#111827;font:16px/1.5 system-ui}',
    'main{max-width:48rem;margin:auto;padding:1rem}button{min-height:44px;padding:.75rem 1rem;',
    'border:0;border-radius:.4rem;background:#1d4ed8;color:#fff;font:inherit}',
    'button:focus-visible{outline:3px solid #f59e0b;outline-offset:3px}',
    '[role=status]{min-height:1.5rem}</style></head><body>',
    `<main data-request-id="${issue.designAuthority.requestId}" `,
    `data-revision-id="${issue.designAuthority.revisionId}" `,
    `data-bundle-digest="${issue.designAuthority.bundleDigest}">`,
    '<h1>Quarterly report</h1>',
    `<p data-purpose>${purpose}</p><p>Revenue and retention summary is ready.</p>`,
    `<button type="button" data-element-id="element-export-button" data-rationale="${rationale}">`,
    'Export report</button><p role="status" aria-live="polite">Ready to export.</p>',
    '</main><script>',
    'document.querySelector("button").addEventListener("click",()=>{',
    'document.querySelector("[role=status]").textContent="Export started.";});',
    '</script></body></html>',
  ].join('');
}

function luminance(rgb: readonly number[]): number {
  const channels = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

async function runHeadlessImplementationEvidence(issue: Issue): Promise<void> {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 767, height: 700 } });
    await page.setContent(implementationHtml(issue));
    const authority = issue.designAuthority;
    if (authority?.provider !== 'designflow') throw new Error('missing Designflow authority');
    const main = page.locator('main');
    expect(await main.getAttribute('data-request-id')).toBe(authority.requestId);
    expect(await main.getAttribute('data-revision-id')).toBe(authority.revisionId);
    expect(await main.getAttribute('data-bundle-digest')).toBe(authority.bundleDigest);
    expect(await page.getByRole('heading', { name: 'Quarterly report' }).count()).toBe(1);
    const button = page.getByRole('button', { name: 'Export report' });
    expect(await button.count()).toBe(1);
    expect((await button.getAttribute('data-rationale'))?.length).toBeGreaterThan(10);
    await page.keyboard.press('Tab');
    expect(await button.evaluate((element) => {
      const pageGlobal = globalThis as unknown as {
        document: { activeElement: unknown };
      };
      return element === pageGlobal.document.activeElement;
    })).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.getByRole('status').textContent()).toBe('Export started.');
    expect(await page.getByRole('status').getAttribute('aria-live')).toBe('polite');
    for (const width of [320, 767]) {
      await page.setViewportSize({ width, height: 700 });
      const overflow = await page.evaluate(() => {
        const pageGlobal = globalThis as unknown as {
          document: {
            documentElement: { scrollWidth: number; clientWidth: number };
          };
        };
        return pageGlobal.document.documentElement.scrollWidth
          > pageGlobal.document.documentElement.clientWidth;
      });
      expect(overflow).toBe(false);
    }
    const foreground = luminance([17, 24, 39]);
    const background = luminance([255, 255, 255]);
    expect((background + 0.05) / (foreground + 0.05)).toBeGreaterThan(7);
  } finally {
    await browser.close();
  }
}

function addReleaseEvalRuns(
  store: Store,
  issue: Issue,
  prId: string,
  revisionId: string,
  headSha: string,
  playwrightPassed: boolean,
): void {
  for (const perspective of PERSPECTIVES) {
    store.addEvalRun(EvalRun.parse({
      id: store.nextId('EVAL', 5),
      issueId: issue.id,
      prId,
      attempt: 1,
      sampleIndex: 0,
      agent: 'mock',
      verdict: 'approve',
      hardGates: perspective.key === 'functionality'
        ? {
            build: 'pass',
            typecheck: 'pass',
            unit_tests: 'pass',
            api_tests: 'pass',
            secrets_scan: 'pass',
            scope_check: 'pass',
            playwright: playwrightPassed ? 'pass' : 'skip',
          }
        : {},
      findings: [],
      scores: {
        functionality: 1,
        codeQuality: 1,
        testQuality: 1,
        ux: 1,
        accessibility: 1,
      },
      overall: 1,
      evidenceDir: perspective.key === 'functionality'
        ? 'evidence/headless-report-workspace'
        : `evidence/review-${perspective.key}`,
      cost: { usd: 0, tokens: 0, seconds: 0 },
      featureArea: 'reporting',
      humanVerdict: null,
      perspective: perspective.key,
      invocationKey: null,
      revisionId,
      headSha,
      createdAt: '2026-07-28T05:00:00.000Z',
    }));
  }
}

async function releaseIssues(
  store: Store,
  cfg: HarnessConfig,
  runner: FakePrRunner,
): Promise<void> {
  const ordered = [...store.db.issues].sort((left, right) =>
    left.planningCandidateKey === CANDIDATE_KEY
      ? 1
      : right.planningCandidateKey === CANDIDATE_KEY
        ? -1
        : left.id.localeCompare(right.id));
  for (const issue of ordered) {
    if (issue.status === 'released') continue;
    const isWorkspace = issue.planningCandidateKey === CANDIDATE_KEY;
    const headSha = isWorkspace ? HEAD_SHA : API_HEAD_SHA;
    const prNumber = isWorkspace ? 109 : 108;
    if (isWorkspace) await runHeadlessImplementationEvidence(issue);
    runner.register(prNumber, headSha);
    const pr = store.addPR(PR.parse({
      id: store.nextId('PR'),
      issueId: issue.id,
      branch: `agent/${issue.planningCandidateKey}`,
      baseBranch: 'main',
      generator: 'mock',
      origin: 'issue-pipeline',
      agentGeneratedHeadSha: headSha,
      attempts: 1,
      externalRef: {
        provider: 'github',
        repository: REPOSITORY,
        number: prNumber,
        url: `https://example.test/acme/reporting/pull/${prNumber}`,
      },
      status: 'open',
      currentRevisionId: null,
      headSha: null,
      mergedHeadSha: null,
      createdAt: '2026-07-28T04:00:00.000Z',
      updatedAt: '2026-07-28T04:00:00.000Z',
    }));
    const revision = observePrRevision(store, pr, headSha);
    addReleaseEvalRuns(store, issue, pr.id, revision.id, headSha, isWorkspace);
    store.save();
    const result = await autoMergeCurrentRevision(
      store,
      cfg,
      store.getPR(pr.id)!,
      runner,
      store.root,
      PERSPECTIVES.map((perspective) => perspective.key),
    );
    expect(result).toMatchObject({ decision: 'merged', merged: true, headSha });
  }
}

function reasonCodes(
  result: ReturnType<typeof evaluateDesignflowReleaseLineage>,
): string[] {
  return result.reasons.map((reason) => reason.code);
}

describe('WF-DF-008 standard-intake grounded headless release', () => {
  it('runs request-changes → new approved revision → capability/API/UI evidence → release', async () => {
    const { root, systemDir } = createRoot();
    const store = new Store(root);
    const cfg = config(systemDir);
    const issueRunner = new FakeGithubIssueRunner();
    const prRunner = new FakePrRunner();
    const fixtures: GenericBundleFixture[] = [];
    let resolverCalls = 0;
    let planningCalls = 0;
    const deps = {
      issueRunner,
      prNativeRunner: prRunner,
      discoverPullRequests: false,
      planningRunner: async () => {
        planningCalls += 1;
        return {
          provider: 'mock' as const,
          model: null,
          prompt: 'Plan WHAT-only report requirements',
          outcome: 'completed' as const,
          output: {
            candidates: [],
            designDrafts: [designDraft()],
            ambiguities: [],
          },
        };
      },
      designflowResolver: async ({ designRequest }: { designRequest: DesignRequest }) => {
        resolverCalls += 1;
        const fixture = createGenericBundleFixture(
          path.join(root, 'relocatable-provider-fixtures'),
          designRequest,
          resolverCalls === 1 ? 1 : 2,
        );
        fixtures.push(fixture);
        return { bundle: fixture.input };
      },
      designflowConsumer: createDesignflowContractConsumer({
        repositoryRoot: process.cwd(),
      }),
      designflowCapabilityReconciler: async (input: DesignflowCapabilityReconcilerInput) =>
        reconciledPlan(input),
      driveQueue: async () => {
        await releaseIssues(store, cfg, prRunner);
        return [];
      },
    };

    await runGithubDevelopmentTurn(store, cfg, deps, root);

    const intakeKey = githubIntakeKey(REPOSITORY, SOURCE_NUMBER);
    const requested = store.planningEnrichmentFor(intakeKey);
    expect(requested).toMatchObject({
      status: 'needs-human-review',
      issueIds: [],
      designDecisionHistory: [{
        candidateKey: CANDIDATE_KEY,
        requestId: requested?.designDrafts[0]?.designRequest.requestId,
        revisionId: GENERIC_REVISION_IDS.requestChanges,
        decisionId: GENERIC_DECISION_IDS.requestChanges,
        supersedesDecisionId: null,
        outcome: 'request-changes',
      }],
    });
    expect(requested?.designDecisionHistory[0]?.reasonCodes).toEqual(
      expect.arrayContaining(['decision-request-changes', 'unresolved-ambiguity']),
    );
    expect(store.db.issues).toEqual([]);
    expect(prRunner.mergeCalls).toEqual([]);

    const rejectedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'designflow-rejected-resume-'),
    );
    roots.push(rejectedRoot);
    fs.cpSync(path.join(root, '.harness'), path.join(rejectedRoot, '.harness'), {
      recursive: true,
    });
    const rejectedStore = new Store(rejectedRoot);
    Object.assign(rejectedStore.db.planningEnrichments[0]!.designDecisionHistory[0]!, {
      outcome: 'reject',
    });
    rejectedStore.save();
    expect(() => resumeDesignPlanningAfterRequestChanges(rejectedStore, intakeKey))
      .toThrow(/not request-changes/);
    expect(rejectedStore.planningEnrichmentFor(intakeKey)?.status)
      .toBe('needs-human-review');

    const staleSupersedesRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'designflow-stale-supersedes-'),
    );
    roots.push(staleSupersedesRoot);
    fs.cpSync(path.join(root, '.harness'), path.join(staleSupersedesRoot, '.harness'), {
      recursive: true,
    });
    const staleSupersedesStore = new Store(staleSupersedesRoot);
    resumeDesignPlanningAfterRequestChanges(staleSupersedesStore, intakeKey);
    await runGithubDevelopmentTurn(staleSupersedesStore, cfg, {
      issueRunner: new FakeGithubIssueRunner(),
      prNativeRunner: new FakePrRunner(),
      discoverPullRequests: false,
      planningRunner: async () => {
        throw new Error('resumed design planning must not rerun WHAT planning');
      },
      designflowResolver: async (
        { designRequest }: { designRequest: DesignRequest },
      ) => {
        const fixture = createGenericBundleFixture(
          path.join(staleSupersedesRoot, 'mutated-provider-fixtures'),
          designRequest,
          2,
        );
        const decisionPath = path.resolve(
          fixture.input.bundleRoot,
          fixture.input.humanDecisionPath!,
        );
        const decision = JSON.parse(
          fs.readFileSync(decisionPath, 'utf8'),
        ) as Record<string, unknown>;
        decision.supersedesDecisionId = WRONG_SUPERSEDES_DECISION_ID;
        fs.writeFileSync(
          decisionPath,
          `${JSON.stringify(decision, null, 2)}\n`,
          'utf8',
        );
        return { bundle: fixture.input };
      },
      designflowConsumer: createDesignflowContractConsumer({
        repositoryRoot: process.cwd(),
      }),
      designflowCapabilityReconciler: async (input: DesignflowCapabilityReconcilerInput) =>
        reconciledPlan(input),
      driveQueue: async () => [],
    }, staleSupersedesRoot);
    const staleSupersedes = staleSupersedesStore.planningEnrichmentFor(intakeKey)!;
    expect(staleSupersedes).toMatchObject({
      status: 'needs-human-review',
      issueIds: [],
    });
    expect(staleSupersedes.reasons.join('\n')).toContain(
      'approved Human Design Decision does not directly supersede '
      + 'the latest request-changes decision',
    );
    expect(staleSupersedes.designDecisionHistory.at(-1)).toMatchObject({
      decisionId: GENERIC_DECISION_IDS.approved,
      supersedesDecisionId: WRONG_SUPERSEDES_DECISION_ID,
      outcome: 'approve',
    });
    expect(staleSupersedesStore.db.issues).toEqual([]);

    const resumed = resumeDesignPlanningAfterRequestChanges(store, intakeKey);
    expect(resumed.status).toBe('awaiting-design');
    expect(resumed.designDecisionHistory).toHaveLength(1);

    await runGithubDevelopmentTurn(store, cfg, deps, root);

    expect(planningCalls).toBe(1);
    expect(resolverCalls).toBe(2);
    expect(issueRunner.claims).toEqual([SOURCE_NUMBER]);
    const accepted = store.planningEnrichmentFor(intakeKey)!;
    expect({ status: accepted.status, reasons: accepted.reasons }).toEqual({
      status: 'accepted',
      reasons: [],
    });
    expect(accepted.designDecisionHistory.map((decision) => ({
      revisionId: decision.revisionId,
      previousRevisionId: decision.previousRevisionId,
      decisionId: decision.decisionId,
      supersedesDecisionId: decision.supersedesDecisionId,
      outcome: decision.outcome,
    }))).toEqual([
      {
        revisionId: GENERIC_REVISION_IDS.requestChanges,
        previousRevisionId: null,
        decisionId: GENERIC_DECISION_IDS.requestChanges,
        supersedesDecisionId: null,
        outcome: 'request-changes',
      },
      {
        revisionId: GENERIC_REVISION_IDS.approved,
        previousRevisionId: GENERIC_REVISION_IDS.requestChanges,
        decisionId: GENERIC_DECISION_IDS.approved,
        supersedesDecisionId: GENERIC_DECISION_IDS.requestChanges,
        outcome: 'approve',
      },
    ]);
    expect([...new Set(accepted.capabilityCoverage.map((edge) => edge.capabilityId))].sort())
      .toEqual([...GENERIC_CAPABILITY_IDS]);
    expect(accepted.capabilityCoverage.every((edge) =>
      edge.systemElementIds.length > 0 && edge.apiOperationIds.length > 0)).toBe(true);

    const releasedIssue = store.db.issues.find(
      (issue) => issue.planningCandidateKey === CANDIDATE_KEY,
    )!;
    expect(releasedIssue).toMatchObject({
      status: 'released',
      area: 'fullstack',
      planningCandidateKey: CANDIDATE_KEY,
      designRevisionId: GENERIC_REVISION_IDS.approved,
      designCapabilityIds: [...GENERIC_CAPABILITY_IDS],
      designAuthority: {
        provider: 'designflow',
        revisionId: GENERIC_REVISION_IDS.approved,
        decisionId: GENERIC_DECISION_IDS.approved,
      },
    });
    expect(releasedIssue.designReview?.purposes).toHaveLength(1);
    expect(releasedIssue.designReview?.effortBudgets).toHaveLength(2);
    expect(releasedIssue.designReview?.attentionHierarchy).toHaveLength(1);
    expect(releasedIssue.designReview?.elements.every((element) =>
      typeof element.placementRationale === 'string'
      && typeof element.removalImpact === 'string')).toBe(true);
    expect(store.db.issues.every((issue) => issue.status === 'released')).toBe(true);
    expect(prRunner.mergeCalls).toEqual([
      { number: 108, head: API_HEAD_SHA },
      { number: 109, head: HEAD_SHA },
    ]);
    expect(prRunner.closeCalls).toEqual([{ repository: REPOSITORY, number: SOURCE_NUMBER }]);

    const lineage = evaluateDesignflowReleaseLineage(store.db, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    });
    expect(lineage).toMatchObject({
      status: 'verified',
      revisionId: GENERIC_REVISION_IDS.approved,
      capabilityIds: [...GENERIC_CAPABILITY_IDS],
      headSha: HEAD_SHA,
      reasons: [],
    });

    const releasedBackendIssue = store.db.issues.find(
      (issue) => issue.planningCandidateKey === 'report-api',
    )!;
    expect(accepted.capabilityCoverage.some(
      (edge) => edge.issueId === releasedBackendIssue.id,
    )).toBe(true);

    const backendUnreleased = structuredClone(store.db);
    const unreleasedBackendIssue = backendUnreleased.issues.find(
      (issue) => issue.id === releasedBackendIssue.id,
    )!;
    Object.assign(unreleasedBackendIssue, { status: 'build-approved' });
    expect(reasonCodes(evaluateDesignflowReleaseLineage(backendUnreleased, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    }))).toContain('release-missing');

    const backendStaleHead = structuredClone(store.db);
    const backendPr = backendStaleHead.prs.find(
      (pr) => pr.issueId === releasedBackendIssue.id,
    )!;
    const backendRevision = backendStaleHead.prRevisions.find(
      (revision) =>
        revision.prId === backendPr.id
        && revision.id === backendPr.currentRevisionId,
    )!;
    const advancedBackendHead = 'e'.repeat(40);
    Object.assign(backendPr, {
      headSha: advancedBackendHead,
      mergedHeadSha: advancedBackendHead,
    });
    Object.assign(backendRevision, { headSha: advancedBackendHead });
    expect(reasonCodes(evaluateDesignflowReleaseLineage(backendStaleHead, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    }))).toContain('gate-lineage-mismatch');

    const staleUx = structuredClone(store.db);
    const uxRun = staleUx.evalRuns.find((run) =>
      run.issueId === releasedIssue.id && run.perspective === 'ux')!;
    Object.assign(uxRun, { headSha: 'f'.repeat(40) });
    expect(reasonCodes(evaluateDesignflowReleaseLineage(staleUx, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    }))).toContain('ux-evidence-missing');

    const brokenCapability = structuredClone(store.db);
    brokenCapability.planningEnrichments[0]!.capabilityCoverage[0]!.apiOperationIds = [
      'missing-operation',
    ];
    expect(reasonCodes(evaluateDesignflowReleaseLineage(brokenCapability, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    }))).toContain('capability-coverage-mismatch');

    const missingCycle = structuredClone(store.db);
    missingCycle.planningEnrichments[0]!.designDecisionHistory =
      missingCycle.planningEnrichments[0]!.designDecisionHistory.filter(
        (decision) => decision.outcome !== 'request-changes',
      );
    expect(reasonCodes(evaluateDesignflowReleaseLineage(missingCycle, {
      intakeKey,
      candidateKey: CANDIDATE_KEY,
      requireRequestChanges: true,
    }))).toContain('decision-cycle-missing');

    const standardFixtureText = fixtures.flatMap((fixture) =>
      fs.readdirSync(fixture.root).map((fileName) =>
        fs.readFileSync(path.join(fixture.root, fileName), 'utf8'))).join('\n');
    const productionText = [
      'src/designflow/release-lineage.ts',
      'src/intake/development-turn.ts',
      'src/intake/planning-enrichment.ts',
    ].map((fileName) => fs.readFileSync(fileName, 'utf8')).join('\n');
    for (const forbidden of [
      'evidence/ciso-05',
      'mrbaron3/workflow#13',
      'mrbaron3/workflow#15',
      'sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa',
    ]) {
      expect(standardFixtureText).not.toContain(forbidden);
      expect(productionText).not.toContain(forbidden);
    }
  }, 30_000);
});
