/** FEAT-013 — common, provider-aware invocation provenance for generator/reviewer sessions. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentInvocation, DB, PrHeadSha, PromptRecord } from '../src/domain/schema.js';
import { Store } from '../src/store/store.js';
import {
  InvocationProvenanceConflictError,
  invocationKey,
  recordAgentInvocation,
} from '../src/agents/invocation.js';
import { computeMetrics } from '../src/metrics/metrics.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { runPanel, type PerspectiveResult } from '../src/pipeline/panel.js';
import type { BuildArtifact } from '../src/domain/artifact.js';
import { reviewerSessionInvocations, reviewJobPaths } from '../src/pipeline/execution/perspective-session.js';

const roots: string[] = [];
function storeAt(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-invocation-'));
  roots.push(root);
  return new Store(root);
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const coordinates = {
  subjectId: 'ISSUE-0042',
  issueId: 'ISSUE-0042',
  prId: 'PR-0001',
  sampleIndex: 0,
  attempt: 1,
  role: 'generator' as const,
  perspective: null,
};

describe('Invocation Identity and recorder', () => {
  it('PR-INTENT rejects partial revision coordinates at compile time', () => {
    if (false) {
      // @ts-expect-error revisionId and headSha are a both-or-neither binding
      invocationKey({ ...coordinates, revisionId: 'PRREV-1' });
      // @ts-expect-error revisionId and headSha are a both-or-neither binding
      invocationKey({ ...coordinates, headSha: PrHeadSha.parse('a'.repeat(40)) });
    }
    expect(invocationKey(coordinates)).toContain('invocation:v1');
  });

  it('AC-AGINV-001 is stable for the same coordinates and distinct across every execution dimension', () => {
    const base = invocationKey(coordinates);
    expect(invocationKey({ ...coordinates })).toBe(base);
    expect(invocationKey({ ...coordinates, sampleIndex: 1 })).not.toBe(base);
    expect(invocationKey({ ...coordinates, attempt: 2 })).not.toBe(base);
    expect(invocationKey({ ...coordinates, role: 'reviewer', perspective: 'security' })).not.toBe(base);
    expect(invocationKey({ ...coordinates, role: 'reviewer', perspective: 'testQuality' })).not.toBe(base);
  });

  it('AC-AGINV-002 stores complete generator provenance without collapsing provider and model', () => {
    const store = storeAt();
    const record = recordAgentInvocation(store, {
      ...coordinates,
      provider: 'claude',
      model: 'sonnet',
      prompt: 'implement this contract',
      outcome: 'completed',
      createdAt: '2026-07-14T00:00:00.000Z',
    });

    expect(record.role).toBe('generator');
    expect(record.provider).toBe('claude');
    expect(record.model).toBe('sonnet');
    expect(record.prompt).toBe('implement this contract');
    expect(record.outcome).toBe('completed');
    expect(store.invocationByKey(record.invocationKey)).toEqual(record);
  });

  it('AC-AGINV-003 stores one isolated invocation per reviewer perspective', () => {
    const store = storeAt();
    const security = recordAgentInvocation(store, {
      ...coordinates,
      role: 'reviewer',
      perspective: 'security',
      provider: 'claude',
      model: null,
      prompt: 'security-only prompt',
      outcome: 'completed',
    });
    const quality = recordAgentInvocation(store, {
      ...coordinates,
      role: 'reviewer',
      perspective: 'testQuality',
      provider: 'codex',
      model: 'gpt-5.1-codex',
      prompt: 'test-quality-only prompt',
      outcome: 'timeout',
    });

    expect(security.invocationKey).not.toBe(quality.invocationKey);
    expect(store.invocationsForIssue('ISSUE-0042').map((r) => r.perspective)).toEqual(['security', 'testQuality']);
  });

  it('AC-AGINV-003 projects actual reviewer provider/model/prompt/outcome per prepared lens', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-review-provenance-'));
    roots.push(root);
    const jobs = ['security', 'testQuality'].map((perspective) => {
      const job = reviewJobPaths(path.join(root, 'worktrees'), path.join(root, 'evidence'), 'issue-42-s0', perspective);
      fs.mkdirSync(path.dirname(job.prompt), { recursive: true });
      fs.writeFileSync(job.prompt, `${perspective} prompt`, 'utf8');
      return job;
    });

    expect(reviewerSessionInvocations(jobs, ['completed', 'timeout'], {
      security: { provider: 'claude', model: 'sonnet' },
      testQuality: { provider: 'claude', model: 'sonnet' },
    })).toEqual([
      { role: 'reviewer', perspective: 'security', provider: 'claude', model: 'sonnet', prompt: 'security prompt', outcome: 'completed' },
      { role: 'reviewer', perspective: 'testQuality', provider: 'claude', model: 'sonnet', prompt: 'testQuality prompt', outcome: 'timeout' },
    ]);
  });

  it('AC-AGINV-004 is idempotent for identical provenance and rejects conflicting provenance', () => {
    const store = storeAt();
    const input = {
      ...coordinates,
      provider: 'claude' as const,
      model: null,
      prompt: 'same prompt',
      outcome: 'stuck' as const,
    };
    const first = recordAgentInvocation(store, input);
    const counter = store.db.counters.INVOKE;
    const again = recordAgentInvocation(store, input);

    expect(again).toEqual(first);
    expect(store.db.agentInvocations).toHaveLength(1);
    expect(store.db.counters.INVOKE).toBe(counter);
    expect(() => recordAgentInvocation(store, { ...input, provider: 'codex' })).toThrow(
      InvocationProvenanceConflictError,
    );
    expect(store.db.agentInvocations).toEqual([first]);
  });

  it('AC-AGINV-005 preserves legacy PromptRecords and starts the additive invocation store empty', () => {
    const legacyPrompt = PromptRecord.parse({
      id: 'PROMPT-0001', issueId: 'ISSUE-0042', prId: 'PR-0001', sampleIndex: 0, attempt: 1,
      agent: 'claude', prompt: 'legacy prompt', createdAt: '2026-07-01T00:00:00.000Z',
    });
    const db = DB.parse({ version: 1, promptRecords: [legacyPrompt] });
    expect(db.promptRecords).toEqual([legacyPrompt]);
    expect(db.agentInvocations).toEqual([]);

    const store = storeAt();
    store.db.promptRecords.push(legacyPrompt);
    recordAgentInvocation(store, {
      ...coordinates, provider: 'claude', model: null, prompt: 'new invocation', outcome: 'completed',
    });
    expect(store.db.promptRecords).toEqual([legacyPrompt]); // no dual-write
    expect(store.db.agentInvocations).toHaveLength(1);
  });
});

describe('evaluation and metrics provenance linkage', () => {
  it('AC-AGINV-006 links a perspective EvalRun and groups invocations by their actual provider', () => {
    const store = storeAt();
    const reviewer = recordAgentInvocation(store, {
      ...coordinates,
      role: 'reviewer', perspective: 'security', provider: 'codex', model: 'gpt-5.1-codex',
      prompt: 'security review', outcome: 'completed',
    });
    recordAgentInvocation(store, {
      ...coordinates,
      role: 'generator', perspective: null, provider: 'claude', model: 'sonnet',
      prompt: 'generator prompt', outcome: 'completed',
    });

    const contract = {
      productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
      acceptanceCriteria: [
        { id: 'AC-1', severity: 'blocker' as const, behavior: 'works', verification: { method: 'unit_test' as const, expected: ['pass'] } },
      ],
      redLines: [],
    };
    const artifact: BuildArtifact = {
      branch: 'b', summary: 's', filesChanged: ['src/x.ts'], satisfied: { 'AC-1': true },
      buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true,
      hasTests: true, secretsLeaked: false, scopeViolations: [],
      quality: { codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 }, notes: [],
    };
    const approved: PerspectiveResult = {
      verdict: 'approve', findings: [],
      scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 }, overall: 1,
    };
    const result = runPanel(
      store,
      { ...DEFAULT_CONFIG, generator: 'claude' },
      {
        issueId: 'ISSUE-0042', prId: 'PR-0001', contract, artifact, sampleIndex: 0, attempt: 1,
        agent: 'claude', invocationKeys: { security: reviewer.invocationKey },
      },
      { perspectives: [{ key: 'security', deterministic: false }], grader: () => approved },
    );

    expect(result.runs[0]!.invocationKey).toBe(reviewer.invocationKey);
    expect(store.invocationByKey(result.runs[0]!.invocationKey!)?.provider).toBe('codex');
    expect(computeMetrics(store).byInvocationProvider).toEqual([
      { provider: 'claude', total: 1, completed: 1, stuck: 0, timeout: 0, failed: 0 },
      { provider: 'codex', total: 1, completed: 1, stuck: 0, timeout: 0, failed: 0 },
    ]);
  });

  it('AgentInvocation schema rejects missing provider and preserves null model as unknown/default', () => {
    const valid = AgentInvocation.parse({
      id: 'INVOKE-0001', invocationKey: 'invocation:v1:x', ...coordinates,
      provider: 'claude', model: null, prompt: 'p', outcome: 'completed', createdAt: '2026-07-14T00:00:00.000Z',
    });
    expect(valid.model).toBeNull();
    expect(() => AgentInvocation.parse({ ...valid, provider: undefined })).toThrow();
  });
});
