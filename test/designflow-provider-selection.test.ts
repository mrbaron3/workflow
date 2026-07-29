import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  ApprovedDesignReviewProjection,
  IntakeRecord,
  Issue,
  type DesignAuthority,
  type IssueContract,
} from '../src/domain/schema.js';
import { renderAuthoritativeDesignContext } from '../src/designflow/authority.js';
import type { DesignflowContractResult } from '../src/designflow/contract-consumer.js';
import {
  runGithubDevelopmentTurn,
  type PlanningRunnerInput,
  type UiDesignRunnerInput,
} from '../src/intake/development-turn.js';
import { buildGeneratorPrompt } from '../src/pipeline/execution/session.js';
import { perspectiveSessionPrompt } from '../src/pipeline/execution/perspective-session.js';
import { Store } from '../src/store/store.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const contract: IssueContract = {
  productGoal: 'Users can export reports',
  userStory: 'As an analyst, I can export the current report',
  scope: { include: ['src/**'], exclude: [] },
  acceptanceCriteria: [{
    id: 'AC-EXPORT-001',
    severity: 'blocker',
    behavior: 'The export action starts an export',
    verification: { method: 'playwright', expected: ['Export starts'] },
  }],
  redLines: [],
};

const legacyCandidate = {
  candidateKey: 'legacy-export',
  title: 'Implement the legacy export action',
  type: 'feature' as const,
  area: 'frontend' as const,
  contract,
  traces: [{
    criterionId: 'AC-EXPORT-001',
    sources: [{ kind: 'source' as const, text: 'export the current report' }],
  }],
};

const designflowDraft = {
  candidateKey: 'designflow-export',
  title: 'Design the revised export action',
  type: 'feature' as const,
  area: 'frontend' as const,
  productIntent: {
    primaryOutcome: 'Users export the current report',
    users: ['Analysts'],
    usageContext: 'While reviewing the current report',
  },
  requirements: [{
    id: 'REQ-EXPORT-001',
    statement: 'Users can export the current report',
    priority: 'blocker' as const,
  }],
  constraints: [],
  targetSurfaces: ['web' as const],
  traces: [{
    requirementId: 'REQ-EXPORT-001',
    sources: [{ kind: 'source' as const, text: 'export the current report' }],
  }],
};

const legacyArtifact = {
  candidateKey: 'legacy-export',
  principles: ['Reuse the existing action hierarchy'],
  tokens: [{
    id: 'space-export',
    category: 'spacing' as const,
    value: 'var(--space-3)',
    rationale: 'Matches adjacent actions',
    sourceCriterionIds: ['AC-EXPORT-001'],
  }],
  components: [{
    id: 'export-action',
    name: 'Export action',
    purpose: 'Starts export',
    states: ['idle', 'loading'],
    interactions: ['activate'],
    accessibility: ['has an accessible name'],
    sourceCriterionIds: ['AC-EXPORT-001'],
  }],
  criterionTraces: [{
    criterionId: 'AC-EXPORT-001',
    designElementIds: ['space-export', 'export-action'],
  }],
};

function setup(
  designProviders: Record<string, 'legacy-ui-design' | 'designflow'>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-design-provider-'));
  roots.push(root);
  const store = new Store(root);
  const intakeKey = 'github:acme%2Fproduct:42';
  store.addIntakeRecord(IntakeRecord.parse({
    id: 'INTAKE-0001',
    intakeKey,
    provider: 'github',
    status: 'claimed',
    snapshot: {
      repository: 'acme/product',
      number: 42,
      externalId: 'I_42',
      title: 'Add report export',
      body: 'Analysts must export the current report.',
      url: 'https://example.test/acme/product/issues/42',
      labels: ['ready'],
      state: 'open',
      sourceUpdatedAt: '2026-07-28T00:00:00.000Z',
      snapshotAt: '2026-07-28T00:00:01.000Z',
    },
    claimedAt: '2026-07-28T00:00:02.000Z',
    createdAt: '2026-07-28T00:00:01.000Z',
    updatedAt: '2026-07-28T00:00:02.000Z',
  }));
  store.save();
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    routes: {
      planning: { provider: 'mock' },
      uiDesign: { provider: 'mock' },
    },
    intake: {
      backend: 'github',
      repository: 'acme/product',
      designProviders,
    },
  };
  return { root, store, config, intakeKey };
}

const noIssues = {
  listReadyIssues: () => [],
  claimIssue: () => {
    throw new Error('pre-claimed intake must not be claimed again');
  },
};

describe('WF-DF-007 explicit design provider selection', () => {
  it('persists a distinct authoritative provider per candidate without dual-writing artifacts', async () => {
    const env = setup({
      'legacy-export': 'legacy-ui-design',
      'designflow-export': 'designflow',
    });
    let planningCalls = 0;
    let legacyCalls = 0;
    const deps = {
      issueRunner: noIssues,
      planningRunner: async ({ route }: PlanningRunnerInput) => {
        planningCalls += 1;
        return {
          provider: route.provider,
          model: route.model,
          prompt: 'split candidates by selected provider',
          outcome: 'completed' as const,
          output: {
            candidates: [legacyCandidate],
            designDrafts: [designflowDraft],
            ambiguities: [],
          },
        };
      },
      uiDesignRunner: async ({ route }: UiDesignRunnerInput) => {
        legacyCalls += 1;
        return {
          provider: route.provider,
          model: route.model,
          prompt: 'legacy adapter prompt',
          outcome: 'completed' as const,
          output: { artifact: legacyArtifact, ambiguities: [] },
        };
      },
      driveQueue: async () => [],
    };

    await runGithubDevelopmentTurn(env.store, env.config, deps, env.root);
    await runGithubDevelopmentTurn(env.store, env.config, deps, env.root);

    expect(planningCalls).toBe(1);
    expect(legacyCalls).toBe(1);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.planningEnrichmentFor(env.intakeKey)).toMatchObject({
      status: 'needs-human-review',
      designProviderSelections: [
        { candidateKey: 'designflow-export', provider: 'designflow' },
        { candidateKey: 'legacy-export', provider: 'legacy-ui-design' },
      ],
      legacyDesigns: [{
        candidateKey: 'legacy-export',
        artifact: { candidateKey: 'legacy-export' },
      }],
      designDrafts: [{ candidate: { candidateKey: 'designflow-export' } }],
    });
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.reasons)
      .toContain('selected Designflow provider is unavailable');
  });

  it('rejects a missing candidate selection before either provider is dispatched', async () => {
    const env = setup({});
    let providerCalls = 0;
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: noIssues,
      planningRunner: async ({ route }) => ({
        provider: route.provider,
        model: route.model,
        prompt: 'unselected UI candidate',
        outcome: 'completed',
        output: { candidates: [legacyCandidate], designDrafts: [], ambiguities: [] },
      }),
      uiDesignRunner: async () => {
        providerCalls += 1;
        throw new Error('unselected legacy provider must not run');
      },
      designflowResolver: async () => {
        providerCalls += 1;
        throw new Error('unselected Designflow provider must not run');
      },
      driveQueue: async () => [],
    }, env.root);

    expect(providerCalls).toBe(0);
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.status)
      .toBe('needs-human-review');
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.reasons.join('\n'))
      .toContain('explicit design provider selection is required');
  });

  it.each(['throw', 'null'] as const)(
    'fails closed on a selected Designflow provider %s and never invokes legacy',
    async (failure) => {
    const env = setup({ 'designflow-export': 'designflow' });
    let legacyCalls = 0;
    let resolverCalls = 0;
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: noIssues,
      planningRunner: async ({ route }) => ({
        provider: route.provider,
        model: route.model,
        prompt: 'Designflow draft',
        outcome: 'completed',
        output: { candidates: [], designDrafts: [designflowDraft], ambiguities: [] },
      }),
      uiDesignRunner: async () => {
        legacyCalls += 1;
        throw new Error('legacy fallback must never run');
      },
      designflowResolver: async () => {
        resolverCalls += 1;
        if (failure === 'throw') throw new Error('provider unavailable');
        return null;
      },
      designflowConsumer: {
        validateBundle: () => {
          throw new Error('unreachable consumer');
        },
      },
      driveQueue: async () => [],
    }, env.root);

    expect(resolverCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    expect(env.store.planningEnrichmentFor(env.intakeKey)).toMatchObject({
      status: 'needs-human-review',
      issueIds: [],
    });
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.reasons.join('\n'))
      .toContain(failure === 'throw' ? 'provider unavailable' : 'returned no resolution');
    expect(env.store.db.issues).toEqual([]);
    },
  );

  it('rejects prose mutated outside the digest-bound materialized bundle with zero Issues', async () => {
    const env = setup({ 'designflow-export': 'designflow' });
    const relativeRevision = path.join('evidence', 'ciso-05', 'design', 'revision-02');
    const sourceRevision = path.join(process.cwd(), relativeRevision);
    const copiedRevision = path.join(env.root, relativeRevision);
    fs.mkdirSync(path.dirname(copiedRevision), { recursive: true });
    fs.cpSync(sourceRevision, copiedRevision, { recursive: true });
    const experiencePath = path.join(copiedRevision, 'experience-contract.json');
    const experience = JSON.parse(fs.readFileSync(experiencePath, 'utf8')) as {
      pagePurposes: Array<{ primaryPurpose: string }>;
    };
    experience.pagePurposes[0]!.primaryPurpose += ' MUTATED OUTSIDE MANIFEST';
    fs.writeFileSync(experiencePath, `${JSON.stringify(experience, null, 2)}\n`, 'utf8');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(copiedRevision, 'design-bundle-manifest.json'), 'utf8'),
    ) as {
      bundleId: string;
      requestId: string;
      revisionId: string;
      sourceDigest: string;
      bundleDigest: string;
      artifacts: Record<string, unknown>;
    };
    const capabilities = JSON.parse(
      fs.readFileSync(path.join(copiedRevision, 'capability-requirements.json'), 'utf8'),
    ) as { capabilities: Array<{ id: string }> };
    const consumed: DesignflowContractResult = {
      providerRef: 'mrbaron3/designflow@contract-v1.0.0-rc.1',
      providerCommit: 'c'.repeat(40),
      contractDigest: `sha256:${'d'.repeat(64)}`,
      bundleId: manifest.bundleId,
      requestId: manifest.requestId,
      revisionId: manifest.revisionId,
      sourceDigest: manifest.sourceDigest,
      bundleDigest: manifest.bundleDigest,
      artifactIds: Object.keys(manifest.artifacts).sort(),
      capabilityIds: capabilities.capabilities.map((capability) => capability.id).sort(),
      decisionId: 'workflow-ciso05-dashboard-r02-approve',
      decisionVerdict: 'approve',
      decisionSupersedesDecisionId: 'workflow-ciso05-dashboard-r01-request-changes',
    };
    let legacyCalls = 0;

    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: noIssues,
      planningRunner: async ({ route }) => ({
        provider: route.provider,
        model: route.model,
        prompt: 'digest-bound Designflow draft',
        outcome: 'completed',
        output: { candidates: [], designDrafts: [designflowDraft], ambiguities: [] },
      }),
      uiDesignRunner: async () => {
        legacyCalls += 1;
        throw new Error('legacy fallback must not run');
      },
      designflowResolver: async () => ({
        bundle: {
          bundleRoot: env.root,
          manifestPath: path.join(relativeRevision, 'design-bundle-manifest.json'),
          designRequestPath: 'unused-by-injected-consumer.json',
          humanDecisionPath: 'unused-by-injected-consumer-decision.json',
        },
      }),
      designflowDecisionGate: () => ({
        status: 'approved',
        requestId: consumed.requestId,
        revisionId: consumed.revisionId,
        bundleDigest: consumed.bundleDigest,
        decisionId: consumed.decisionId ?? null,
        supersedesDecisionId: consumed.decisionSupersedesDecisionId ?? null,
        reasons: [],
      }),
      designflowConsumer: { validateBundle: () => consumed },
      designflowCapabilityReconciler: async () => {
        throw new Error('mutated projection must stop before reconciliation');
      },
      driveQueue: async () => [],
    }, env.root);

    expect(legacyCalls).toBe(0);
    expect(env.store.db.issues).toEqual([]);
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.status)
      .toBe('needs-human-review');
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.reasons.join('\n'))
      .toContain('Experience Contract digest');
  });

  it('does not inspect design configuration or add a gate for backend-only planning', async () => {
    const env = setup({ api: 'invalid' as never });
    let designCalls = 0;
    await runGithubDevelopmentTurn(env.store, env.config, {
      issueRunner: noIssues,
      planningRunner: async ({ route }) => ({
        provider: route.provider,
        model: route.model,
        prompt: 'backend only',
        outcome: 'completed',
        output: {
          candidates: [{
            ...legacyCandidate,
            candidateKey: 'api',
            area: 'backend',
          }],
          designDrafts: [],
          ambiguities: [],
        },
      }),
      uiDesignRunner: async () => {
        designCalls += 1;
        throw new Error('backend must not enter a design gate');
      },
      designflowResolver: async () => {
        designCalls += 1;
        throw new Error('backend must not enter a design gate');
      },
      driveQueue: async () => [],
    }, env.root);

    expect(designCalls).toBe(0);
    expect(env.store.planningEnrichmentFor(env.intakeKey)?.status).toBe('accepted');
    expect(env.store.db.issues).toHaveLength(1);
    expect(env.store.db.issues[0]?.designAuthority).toBeNull();
  });
});

describe('single revision prompt provenance', () => {
  const authority: DesignAuthority = {
    provider: 'designflow',
    providerRef: 'mrbaron3/designflow@contract-v1.0.0-rc.1',
    candidateKey: 'designflow-export',
    requestId: 'request-export-001',
    revisionId: 'revision-export-002',
    bundleDigest: `sha256:${'a'.repeat(64)}`,
    decisionId: 'decision-export-002',
  };
  const review = ApprovedDesignReviewProjection.parse({
    identity: {
      schemaVersion: '1.0',
      bundleId: 'bundle-export-002',
      requestId: authority.requestId,
      revisionId: authority.revisionId,
      previousRevisionId: 'revision-export-001',
      createdAt: '2026-07-28T00:00:00.000Z',
    },
    purposes: [{
      id: 'purpose-export',
      purpose: 'Export the current report',
      successOutcome: 'Export starts without losing context',
    }],
    tasks: [{
      id: 'task-export',
      goal: 'Start export',
      criticality: 'primary',
    }],
    effortBudgets: [{
      id: 'effort-export',
      maxPrimaryActions: 1,
      maxDecisions: 1,
      maxContextSwitches: 0,
    }],
    attentionHierarchy: [{
      pagePurpose: { id: 'purpose-export' },
      levels: [{ level: 1, elementIds: ['element-export'] }],
    }],
    elements: [{
      id: 'element-export',
      placementRationale: 'Keep the action with the current report',
      removalImpact: 'Analysts cannot export the current report',
    }],
    designSystemDelta: {
      decisions: [{
        action: 'reuse',
        targetType: 'component',
        targetId: 'button',
      }],
    },
    capabilityDelta: [{
      id: 'CAP-EXPORT-001',
      kind: 'command',
      userIntent: 'Start report export',
      successOutcome: 'Export starts',
    }],
    revisionDiff: 'Approved the direct export action.',
    ambiguities: [],
    digest: {
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      bundleDigest: authority.bundleDigest,
      artifacts: [{
        kind: 'experience',
        path: 'experience-contract.json',
        digest: `sha256:${'d'.repeat(64)}`,
      }],
    },
  });

  const issue = Issue.parse({
    id: 'ISSUE-0001',
    type: 'feature',
    title: 'Implement approved export',
    area: 'frontend',
    status: 'contract-drafted',
    contract,
    planningCandidateKey: authority.candidateKey,
    designRequestId: authority.requestId,
    designRevisionId: authority.revisionId,
    designBundleDigest: authority.bundleDigest,
    designCapabilityIds: ['CAP-EXPORT-001'],
    designAuthority: authority,
    designReview: review,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  });

  it('uses the same approved revision block in generator and PR reviewer prompts', () => {
    const expected = renderAuthoritativeDesignContext(authority, review);
    const generator = buildGeneratorPrompt({
      issue,
      contract,
      sampleIndex: 0,
      attempt: 1,
    }, { repo: '.' });
    const reviewer = perspectiveSessionPrompt({
      worktree: '/tmp/generator',
      contract,
      perspectives: [],
      issueKey: issue.id,
      repo: '/tmp/repository',
      buildRef: 'b'.repeat(40),
      baseRef: 'main',
      designAuthority: issue.designAuthority,
      designReview: issue.designReview,
    }, 'ux', '.agentops/eval/ux');

    expect(generator).toContain(expected);
    expect(reviewer).toContain(expected);
    expect(generator.match(/Revision: revision-export-002/g)).toHaveLength(1);
    expect(reviewer.match(/Revision: revision-export-002/g)).toHaveLength(1);
    expect(generator).toContain('Export the current report');
    expect(reviewer).toContain('Keep the action with the current report');
  });

  it('rejects dual-write and revision drift in the Issue projection', () => {
    expect(Issue.safeParse({
      ...issue,
      uiDesign: legacyArtifact,
      uiDesignInvocationKey: 'legacy-invocation',
    }).success).toBe(false);
    expect(Issue.safeParse({
      ...issue,
      designRevisionId: 'revision-export-003',
    }).success).toBe(false);
  });
});
