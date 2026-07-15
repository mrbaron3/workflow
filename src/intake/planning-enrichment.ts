/** Trace-complete planning enrichment gate (FEAT-017 / ADR-0008 I2). */
import {
  Issue,
  PlanningEnrichmentOutput,
  PlanningEnrichmentRecord,
  UiDesignOutput,
  type EnrichmentCandidate,
  type PlanningEnrichmentRecord as PlanningEnrichmentRecordType,
  type UiDesignArtifact,
} from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import { resolvedGeneratorProvider } from '../agents/routing.js';
import { resolveSystemContext } from '../pipeline/execution/scoped-context.js';
import { Store, nowISO } from '../store/store.js';

export interface ApplyPlanningEnrichmentOptions {
  systemDir: string;
  invocationKey: string | null;
  uiDesigns?: Record<string, UiDesignAttempt>;
}

export interface UiDesignAttempt {
  output: unknown;
  invocationKey: string | null;
}

interface CandidateValidation {
  candidate: EnrichmentCandidate;
  systemIds: string[];
}

/** UI work must not enter the generic generator lane without a validated design contract. */
export function requiresUiDesign(candidate: EnrichmentCandidate): boolean {
  return candidate.area === 'frontend' || candidate.area === 'fullstack';
}

/** Stable provenance subject for an independently-routed UI authoring session. */
export function uiDesignSubjectId(intakeKey: string, candidateKey: string): string {
  return `${intakeKey}:ui-design:${encodeURIComponent(candidateKey)}`;
}

function traceReasons(
  candidates: readonly EnrichmentCandidate[],
  sourceText: string,
  systemDir: string,
): { reasons: string[]; validated: CandidateValidation[] } {
  const reasons: string[] = [];
  const validated: CandidateValidation[] = [];
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    if (candidateKeys.has(candidate.candidateKey)) {
      reasons.push(`duplicate candidateKey: ${candidate.candidateKey}`);
    }
    candidateKeys.add(candidate.candidateKey);
    const acIds = candidate.contract.acceptanceCriteria.map((criterion) => criterion.id);
    const acSet = new Set(acIds);
    if (acSet.size !== acIds.length) {
      reasons.push(`${candidate.candidateKey}: duplicate acceptance criterion ids`);
    }
    const traceCounts = new Map<string, number>();
    const systemIds: string[] = [];
    for (const criterion of candidate.contract.acceptanceCriteria) {
      if (criterion.verification.method === 'manual') {
        reasons.push(`${candidate.candidateKey}/${criterion.id}: manual verification is not executable`);
      }
    }
    for (const trace of candidate.traces) {
      traceCounts.set(trace.criterionId, (traceCounts.get(trace.criterionId) ?? 0) + 1);
      if (!acSet.has(trace.criterionId)) {
        reasons.push(`${candidate.candidateKey}: extra trace for ${trace.criterionId}`);
      }
      for (const source of trace.sources) {
        if (source.kind === 'source') {
          if (!sourceText.includes(source.text)) {
            reasons.push(`${candidate.candidateKey}/${trace.criterionId}: source text not found: ${source.text}`);
          }
        } else {
          systemIds.push(source.elementId);
        }
      }
    }
    for (const acId of acIds) {
      const count = traceCounts.get(acId) ?? 0;
      if (count !== 1) reasons.push(`${candidate.candidateKey}: ${acId} has ${count} trace entries (expected 1)`);
    }
    const uniqueSystemIds = [...new Set(systemIds)];
    const resolved = resolveSystemContext(uniqueSystemIds, systemDir);
    for (const missing of resolved.missing) {
      reasons.push(`${candidate.candidateKey}: missing system element ${missing}`);
    }
    validated.push({ candidate, systemIds: uniqueSystemIds });
  }
  return { reasons, validated };
}

interface UiDesignValidation {
  artifact: UiDesignArtifact | null;
  invocationKey: string | null;
  reasons: string[];
}

function validateUiDesign(
  store: Store,
  intakeKey: string,
  candidate: EnrichmentCandidate,
  attempt: UiDesignAttempt | undefined,
): UiDesignValidation {
  const prefix = `${candidate.candidateKey}: UI design`;
  if (!requiresUiDesign(candidate)) {
    return attempt
      ? { artifact: null, invocationKey: attempt.invocationKey, reasons: [`${prefix} was supplied for non-UI ${candidate.area} work`] }
      : { artifact: null, invocationKey: null, reasons: [] };
  }
  if (!attempt) {
    return {
      artifact: null,
      invocationKey: null,
      reasons: [`${prefix} artifact is required for ${candidate.area} work`],
    };
  }

  const reasons: string[] = [];
  const invocation = attempt.invocationKey ? store.invocationByKey(attempt.invocationKey) : undefined;
  if (!attempt.invocationKey) reasons.push(`${prefix} invocationKey is required`);
  else if (!invocation) reasons.push(`${prefix} invocation not found: ${attempt.invocationKey}`);
  else {
    const expectedSubject = uiDesignSubjectId(intakeKey, candidate.candidateKey);
    if (invocation.role !== 'ui-designer') reasons.push(`${prefix} invocation role must be ui-designer, got ${invocation.role}`);
    if (invocation.subjectId !== expectedSubject) {
      reasons.push(`${prefix} invocation subject ${invocation.subjectId} does not match ${expectedSubject}`);
    }
    if (invocation.outcome !== 'completed') {
      reasons.push(`${prefix} invocation outcome must be completed, got ${invocation.outcome}`);
    }
  }

  const parsed = UiDesignOutput.safeParse(attempt.output);
  if (!parsed.success) {
    reasons.push(`${prefix} output is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    return { artifact: null, invocationKey: attempt.invocationKey, reasons };
  }
  reasons.push(...parsed.data.ambiguities.map((ambiguity) => `${prefix} ambiguity: ${ambiguity}`));
  if (!parsed.data.artifact) {
    reasons.push(`${prefix} artifact is missing`);
    return { artifact: null, invocationKey: attempt.invocationKey, reasons };
  }

  const artifact = parsed.data.artifact;
  if (artifact.candidateKey !== candidate.candidateKey) {
    reasons.push(`${prefix} candidateKey is ${artifact.candidateKey}`);
  }
  const criterionIds = candidate.contract.acceptanceCriteria.map((criterion) => criterion.id);
  const criterionSet = new Set(criterionIds);
  const elements = [...artifact.tokens, ...artifact.components];
  const elementIds = elements.map((element) => element.id);
  const elementSet = new Set(elementIds);
  if (elementSet.size !== elementIds.length) reasons.push(`${prefix} element ids must be unique`);

  for (const element of elements) {
    for (const criterionId of element.sourceCriterionIds) {
      if (!criterionSet.has(criterionId)) {
        reasons.push(`${prefix} element ${element.id} references unknown criterion ${criterionId}`);
      }
    }
  }
  const traceCounts = new Map<string, number>();
  for (const trace of artifact.criterionTraces) {
    traceCounts.set(trace.criterionId, (traceCounts.get(trace.criterionId) ?? 0) + 1);
    if (!criterionSet.has(trace.criterionId)) {
      reasons.push(`${prefix} has extra criterion trace ${trace.criterionId}`);
    }
    for (const elementId of trace.designElementIds) {
      if (!elementSet.has(elementId)) {
        reasons.push(`${prefix}/${trace.criterionId} references unknown design element ${elementId}`);
      }
    }
  }
  for (const criterionId of criterionIds) {
    const count = traceCounts.get(criterionId) ?? 0;
    if (count !== 1) reasons.push(`${prefix} criterion ${criterionId} has ${count} traces (expected 1)`);
  }
  return { artifact, invocationKey: attempt.invocationKey, reasons };
}

function provenanceReasons(store: Store, intakeKey: string, invocationKey: string | null): string[] {
  if (!invocationKey) return ['planning invocationKey is required'];
  const invocation = store.invocationByKey(invocationKey);
  if (!invocation) return [`planning invocation not found: ${invocationKey}`];
  const reasons: string[] = [];
  if (invocation.role !== 'issue-planner') reasons.push(`invocation role must be issue-planner, got ${invocation.role}`);
  if (invocation.subjectId !== intakeKey) reasons.push(`invocation subject ${invocation.subjectId} does not match ${intakeKey}`);
  if (invocation.outcome !== 'completed') reasons.push(`planning invocation outcome must be completed, got ${invocation.outcome}`);
  return reasons;
}

/**
 * Validate the whole non-deterministic output before allocating any Issue id. On any uncertainty,
 * persist one needs-human-review decision and zero Issues; accepted outputs project atomically.
 */
export function applyPlanningEnrichment(
  store: Store,
  config: HarnessConfig,
  intakeKey: string,
  rawOutput: unknown,
  opts: ApplyPlanningEnrichmentOptions,
): PlanningEnrichmentRecordType {
  const existing = store.planningEnrichmentFor(intakeKey);
  if (existing) return existing;
  const intake = store.intakeByKey(intakeKey);
  if (!intake) throw new Error(`No intake record: ${intakeKey}`);

  const parsed = PlanningEnrichmentOutput.safeParse(rawOutput);
  const reasons = provenanceReasons(store, intakeKey, opts.invocationKey);
  let validated: CandidateValidation[] = [];
  const uiDesigns = opts.uiDesigns ?? {};
  const validatedUiDesigns = new Map<string, UiDesignValidation>();
  if (!parsed.success) {
    reasons.push(`invalid planning output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  } else {
    reasons.push(...parsed.data.ambiguities.map((ambiguity) => `planning ambiguity: ${ambiguity}`));
    const trace = traceReasons(
      parsed.data.candidates,
      `${intake.snapshot.title}\n${intake.snapshot.body}`,
      opts.systemDir,
    );
    reasons.push(...trace.reasons);
    validated = trace.validated;
    const plannedKeys = new Set(parsed.data.candidates.map((candidate) => candidate.candidateKey));
    for (const candidate of parsed.data.candidates) {
      const uiDesign = validateUiDesign(store, intakeKey, candidate, uiDesigns[candidate.candidateKey]);
      validatedUiDesigns.set(candidate.candidateKey, uiDesign);
      reasons.push(...uiDesign.reasons);
    }
    for (const candidateKey of Object.keys(uiDesigns)) {
      if (!plannedKeys.has(candidateKey)) reasons.push(`unexpected UI design candidateKey: ${candidateKey}`);
    }
  }
  if (intake.status !== 'claimed' && intake.status !== 'planning') {
    reasons.push(`intake status must be claimed/planning, got ${intake.status}`);
  }

  const createdAt = nowISO();
  const uiDesignInvocationKeys = Object.fromEntries(
    Object.entries(uiDesigns)
      .filter((entry): entry is [string, UiDesignAttempt & { invocationKey: string }] => entry[1].invocationKey !== null)
      .map(([candidateKey, attempt]) => [candidateKey, attempt.invocationKey]),
  );
  if (reasons.length > 0) {
    const record = store.addPlanningEnrichment(
      PlanningEnrichmentRecord.parse({
        id: store.nextId('ENRICH'), intakeKey, invocationKey: opts.invocationKey,
        status: 'needs-human-review', reasons, traces: [], issueIds: [],
        uiDesignCandidateKeys: [], uiDesignInvocationKeys, createdAt,
      }),
    );
    intake.status = 'needs-human-review';
    intake.updatedAt = createdAt;
    store.save();
    return record;
  }

  const provider = resolvedGeneratorProvider(config);
  const issues = validated.map(({ candidate, systemIds }) => {
    const uiDesign = validatedUiDesigns.get(candidate.candidateKey);
    return Issue.parse({
      id: store.nextId('ISSUE'),
      type: candidate.type,
      title: candidate.title,
      area: candidate.area,
      status: 'contract-drafted',
      assignedAgent: provider,
      contract: candidate.contract,
      dependsOnSystem: systemIds,
      intakeKey,
      planningCandidateKey: candidate.candidateKey,
      uiDesign: uiDesign?.artifact ?? null,
      uiDesignInvocationKey: uiDesign?.invocationKey ?? null,
      createdAt,
      updatedAt: createdAt,
    });
  });
  for (const issue of issues) store.addIssue(issue);

  const traces = validated.flatMap(({ candidate }) =>
    candidate.traces.map((trace) => ({ candidateKey: candidate.candidateKey, ...trace })),
  );
  const record = store.addPlanningEnrichment(
    PlanningEnrichmentRecord.parse({
      id: store.nextId('ENRICH'), intakeKey, invocationKey: opts.invocationKey,
      status: 'accepted', reasons: [], traces, issueIds: issues.map((issue) => issue.id),
      uiDesignCandidateKeys: [...validatedUiDesigns.entries()]
        .filter(([, design]) => design.artifact !== null)
        .map(([candidateKey]) => candidateKey),
      uiDesignInvocationKeys,
      createdAt,
    }),
  );
  intake.status = 'ready';
  intake.storeIssueIds = record.issueIds;
  intake.updatedAt = createdAt;
  store.save();
  return record;
}
