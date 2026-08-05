import fs from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  ciso07SemanticErrors,
} from '../src/evidence/ciso07.js';

const head = 'a'.repeat(40);
const initialHead = 'b'.repeat(40);
const round2Head = 'c'.repeat(40);
const digest = `sha256:${'d'.repeat(64)}`;
const sha256 = 'e'.repeat(64);
const registrationId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const leaseId = '44444444-4444-4444-8444-444444444444';
const reviewer = (
  agent: 'codex' | 'claude',
  reviewHead: string,
  suffix: string,
) => ({
  agent,
  taskId: `task_${suffix}`,
  dispatchId: `ctx_${suffix}`,
  findingMessageId: `msg_${suffix}`,
  doneMessageId: `msg_${suffix}f`,
  head: reviewHead,
  readOnly: true,
  worktreeClean: true,
  findingCount: 1,
  verdict: 'findings',
});
const image = (role: string) => ({
  reference: `agentops-${role}:ciso07-final`,
  digest,
  sourceHead: head,
  containerfileSha256: sha256,
  scanReportSha256: sha256,
});
const mount = (
  type: 'tmpfs' | 'volume',
  destination: string,
  readOnly: boolean,
  name?: string,
) => ({ type, destination, readOnly, ...(name ? { name } : {}) });
const container = (
  role: string,
  mounts: ReturnType<typeof mount>[],
  publishedPorts: string[] = [],
) => ({
  name: `agentops-ciso07-dogfood-${role}`,
  state: 'running',
  imageDigest: digest,
  specSha256: sha256,
  networks: ['agentops-ciso07-dogfood-internal'],
  publishedPorts,
  publishedSockets: [],
  mounts,
});

function validEvidence() {
  return {
    schemaVersion: '1.0',
    issue: 'mrbaron3/workflow#17',
    source: {
      immutableBase: '257dc557753b099a646c94d3e3cc700468ffb32a',
      initialHead,
      finalHead: head,
      treeSha256: sha256,
      pullRequest: 41,
      capturedAt: '2026-07-26T00:00:00Z',
    },
    images: {
      control: image('control'),
      runner: image('runner'),
      postgres: image('postgres'),
    },
    topology: {
      passed: true,
      observedAt: '2026-07-26T00:01:00Z',
      network: 'agentops-ciso07-dogfood-internal',
      control: container(
        'control',
        [mount('tmpfs', '/tmp', false)],
        ['127.0.0.1:18097:8080/tcp'],
      ),
      runner: container('runner', [
        mount('tmpfs', '/tmp', false),
        mount('tmpfs', '/home/agentops', false),
        mount(
          'volume',
          '/workspace',
          false,
          'agentops-ciso07-dogfood-runner-workspace',
        ),
        mount(
          'volume',
          '/run/agentops-credentials',
          true,
          'agentops-ciso07-dogfood-runner-credentials',
        ),
      ]),
      postgres: container('postgres', [
        mount(
          'volume',
          '/var/lib/postgresql',
          false,
          'agentops-ciso07-dogfood-postgres-data',
        ),
        mount('tmpfs', '/run/postgresql', false),
        mount('tmpfs', '/tmp', false),
      ]),
      loopbackListen: { address: '127.0.0.1', port: 18097, observed: true },
      forbiddenMountsAbsent: {
        hostHome: true,
        developmentRoot: true,
        sshAgent: true,
        containerSocket: true,
      },
    },
    registration: {
      passed: true,
      observedAt: '2026-07-26T00:02:00Z',
      id: registrationId,
      repository: 'mrbaron3/workflow',
      version: 3,
      onlyRegistration: true,
      enabled: true,
      issueMonitorEnabled: true,
      prMonitorEnabled: true,
      executionEnabled: true,
    },
    monitoring: {
      passed: true,
      observedAt: '2026-07-26T00:03:00Z',
      mode: 'MONITOR_ONLY',
      issueActual: 'running',
      prActual: 'running',
      issueCursor: {
        updatedAfter: '2026-07-26T00:00:00Z',
        observedAt: '2026-07-26T00:03:00Z',
        sha256,
      },
      prCursor: {
        updatedAfter: '2026-07-26T00:00:00Z',
        observedAt: '2026-07-26T00:03:00Z',
        sha256,
      },
      brokerAuditSha256: sha256,
      webhookDeliveryId: '55555555-5555-4555-8555-555555555555',
      duplicateDeliveryId: '66666666-6666-4666-8666-666666666666',
      unregisteredDeliveryId: '77777777-7777-4777-8777-777777777777',
      disabledDeliveryId: '88888888-8888-4888-8888-888888888888',
      monitorOnlyJobCount: 0,
      initial404Preserved: true,
    },
    execution: {
      passed: true,
      observedAt: '2026-07-26T00:04:00Z',
      mode: 'ACTIVE',
      jobId,
      attemptId,
      leaseId,
      registrationVersion: 3,
      expectedHead: head,
      finalHead: head,
      deduplicatedSources: ['webhook', 'poll'],
      auditSha256: sha256,
      artifactReferenceSha256: sha256,
    },
    recovery: {
      passed: true,
      drainingAt: '2026-07-26T00:05:00Z',
      offAt: '2026-07-26T00:06:00Z',
      restartedAt: '2026-07-26T00:07:00Z',
      macListenAbsentInOff: true,
      registrationId,
      registrationVersion: 3,
      cursorDigestBefore: sha256,
      cursorDigestAfter: sha256,
      jobId,
      attemptId,
      leaseId,
      auditReferenceCount: 1,
      artifactReferenceCount: 1,
      postgresVolume: 'agentops-ciso07-dogfood-postgres-data',
      runnerVolume: 'agentops-ciso07-dogfood-runner-workspace',
    },
    formalReviews: {
      roundCount: 2,
      round1: {
        passed: true,
        head: initialHead,
        codex: reviewer('codex', initialHead, '11'),
        claude: reviewer('claude', initialHead, '12'),
        allConfirmedFindingsResolved: true,
      },
      round2: {
        passed: true,
        head: round2Head,
        codex: reviewer('codex', round2Head, '21'),
        claude: reviewer('claude', round2Head, '22'),
        allConfirmedFindingsResolved: true,
      },
      round3Created: false,
    },
    github: {
      observedAt: '2026-07-26T00:08:00Z',
      pullRequest: 41,
      finalPrHead: head,
      mergeSha: 'f'.repeat(40),
      expectedHeadProtected: true,
      requiredChecks: { macos: 'SUCCESS', postgres: 'SUCCESS' },
      blockingReviewThreads: 0,
      issueState: 'CLOSED',
      issueStateReason: 'COMPLETED',
      mergeReachableFromOriginMain: true,
    },
    artifacts: [
      {
        kind: 'validation-report',
        uri: 'evidence/ciso-07/validation.json',
        sha256,
        sizeBytes: 1,
        sourceHead: head,
        observedAt: '2026-07-26T00:08:00Z',
      },
      {
        kind: 'image-scan',
        uri: 'evidence/ciso-07/image-scan.json',
        sha256,
        sizeBytes: 1,
        sourceHead: head,
        observedAt: '2026-07-26T00:08:00Z',
      },
      {
        kind: 'github-current-state',
        uri: 'evidence/ciso-07/github.json',
        sha256,
        sizeBytes: 1,
        sourceHead: head,
        observedAt: '2026-07-26T00:08:00Z',
      },
    ],
    result: 'passed',
  };
}

describe('CISO-07 release evidence semantic binding', () => {
  it('accepts one structurally complete and coherently bound release', () => {
    const schema = JSON.parse(
      fs.readFileSync('contracts/ciso-07-release-evidence.schema.json', 'utf8'),
    ) as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const evidence = validEvidence();
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(ciso07SemanticErrors(evidence)).toEqual([]);
  });

  it.each([
    ['source binding', (value: any) => { value.images.control.sourceHead = '9'.repeat(40); }],
    ['role digest', (value: any) => { value.topology.runner.imageDigest = `sha256:${'9'.repeat(64)}`; }],
    ['review head', (value: any) => { value.formalReviews.round2.codex.head = head; }],
    ['review verdict', (value: any) => { value.formalReviews.round2.codex.verdict = 'no_findings'; }],
    ['timestamp order', (value: any) => { value.recovery.offAt = '2026-07-26T00:09:00Z'; }],
    ['registration recovery', (value: any) => { value.recovery.registrationVersion = 4; }],
    ['cursor recovery', (value: any) => { value.recovery.cursorDigestAfter = '9'.repeat(64); }],
    ['execution recovery', (value: any) => { value.recovery.leaseId = registrationId; }],
    ['artifact kinds', (value: any) => { value.artifacts[1].kind = 'runtime-status'; }],
    ['artifact dot path', (value: any) => { value.artifacts[0].uri = 'evidence/ciso-07/../escape'; }],
    ['role mounts', (value: any) => { value.topology.runner.mounts.pop(); }],
  ])('rejects a complete fixture with incoherent %s', (_name, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(ciso07SemanticErrors(evidence).length).toBeGreaterThan(0);
  });
});
