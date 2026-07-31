/** Trace-complete planning enrichment gate (FEAT-017 / ADR-0008 I2). */
import {
  CapabilityCoverageProjection,
  DesignContractProvider,
  DesignPlanningDecision,
  DesignPlanningDraft,
  DesignProviderSelection,
  DesignRequest,
  Issue,
  LegacyDesignRevision,
  PlanningEnrichmentOutput,
  PlanningEnrichmentRecord,
  UiDesignOutput,
  VerificationMethod,
  type CapabilityReconciliationInput,
  type ApprovedDesignReviewProjection,
  type DesignContractProvider as DesignContractProviderType,
  type DesignPlanningDecision as DesignPlanningDecisionType,
  type DesignDraftCandidate,
  type DesignRequest as DesignRequestType,
  type EnrichmentCandidate,
  type IntakeRecord,
  type PlanningEnrichmentRecord as PlanningEnrichmentRecordType,
  type UiDesignArtifact,
} from '../domain/schema.js';
import {
  configuredGraderCommand,
  type HarnessConfig,
  type TargetRepoConfig,
} from '../config.js';
import { resolvedGeneratorProvider } from '../agents/routing.js';
import { resolveSystemContext } from '../pipeline/execution/scoped-context.js';
import { Store, nowISO } from '../store/store.js';
import {
  digestDesignflowArtifact,
  type DesignflowContractResult,
} from '../designflow/contract-consumer.js';
import { legacyDesignAuthority } from '../designflow/authority.js';
import type { DesignDecisionGateResult } from '../designflow/decision-gate.js';
import {
  reconcileDesignCapabilities,
  type CapabilityReconciliationResult,
} from '../designflow/capability-reconciliation.js';

export interface ApplyPlanningEnrichmentOptions {
  systemDir: string;
  invocationKey: string | null;
  /** Independently authored legacy artifacts keyed by planner candidate. */
  uiDesigns?: Record<string, UiDesignAttempt>;
}

export interface UiDesignAttempt {
  output: unknown;
  invocationKey: string | null;
}

/**
 * The planner may only promise evidence the immutable-at-claim repository
 * profile can actually execute. scope_check is intrinsic; every other method
 * needs a bounded configured command.
 */
export function supportedPlanningVerificationMethods(
  target: TargetRepoConfig,
): VerificationMethod[] {
  return VerificationMethod.options.filter((method) =>
    method !== 'manual'
    && (
      method === 'scope_check'
      || configuredGraderCommand(target, method) !== undefined
    ));
}

/**
 * scope_check's matcher supports repo-relative paths plus `*` / `**`.
 * Planning output is untrusted prose, so reject descriptions and unsupported
 * glob dialects before they can turn every legitimate edit out-of-scope.
 */
export function isPlanningScopeGlob(pattern: string): boolean {
  if (!/^[A-Za-z0-9._/*-]+$/.test(pattern) || pattern.startsWith('/')) {
    return false;
  }
  const segments = pattern.split('/');
  return segments.every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..');
}

export interface ApprovedDesignResolution {
  candidateKey: string;
  /** Null when WF-DF-004 rejected the raw bundle before contract consumption. */
  contract: DesignflowContractResult | null;
  decisionGate: DesignDecisionGateResult;
  /** Workflow-generated WF-DF-005 projection for the exact consumed bundle. */
  reviewProjection: ApprovedDesignReviewProjection | null;
  /** Null until the workflow planner consumes an exact gate-approved capability revision. */
  reconciliation: CapabilityReconciliationInput | null;
}

interface CandidateValidation {
  candidate: EnrichmentCandidate;
  systemIds: string[];
}

interface DesignDraftValidation {
  candidate: DesignDraftCandidate;
  systemIds: string[];
}

interface SelectedDesignProvider {
  candidateKey: string;
  provider: DesignContractProviderType;
}

/** UI work must not enter the generic generator lane without a validated design contract. */
export function requiresUiDesign(candidate: EnrichmentCandidate): boolean {
  return candidate.area === 'frontend' || candidate.area === 'fullstack';
}

/** Stable provenance subject for an independently-routed UI authoring session. */
export function uiDesignSubjectId(intakeKey: string, candidateKey: string): string {
  return `${intakeKey}:ui-design:${encodeURIComponent(candidateKey)}`;
}

function stripStrongMarkers(prose: string): string {
  return prose
    .replace(/(?<![\\*])\*\*(?=\S)(.*?\S)(?<!\\)\*\*(?!\*)/g, '$1')
    .replace(
      /(?<![\\_\p{L}\p{N}])__(?=\S)(.*?\S)(?<!\\)__(?![_\p{L}\p{N}])/gu,
      '$1',
    );
}

/**
 * Remove Markdown strong presentation markers without changing code spans or
 * fenced code. Planning traces identify visible source language, so a provider
 * omitting `**` / `__` must not create a false WHAT stop; lexical and inline
 * code differences remain exact.
 */
function normalizeStrongPresentation(markdown: string): string {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let inlineTicks = 0;
  let normalized = '';

  for (const lineWithEnding of lines) {
    if (lineWithEnding === '') continue;
    const hasNewline = lineWithEnding.endsWith('\n');
    const line = hasNewline ? lineWithEnding.slice(0, -1) : lineWithEnding;

    if (fence) {
      normalized += lineWithEnding;
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        close
        && close[1]![0] === fence.marker
        && close[1]!.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    if (inlineTicks === 0) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) {
        const marker = open[1]![0] as '`' | '~';
        fence = { marker, length: open[1]!.length };
        normalized += lineWithEnding;
        continue;
      }
    }

    let prose = '';
    const flushProse = (): void => {
      normalized += stripStrongMarkers(prose);
      prose = '';
    };
    for (let index = 0; index < line.length;) {
      if (line[index] !== '`') {
        if (inlineTicks === 0) prose += line[index];
        else normalized += line[index];
        index += 1;
        continue;
      }

      let end = index + 1;
      while (line[end] === '`') end += 1;
      const ticks = end - index;
      if (inlineTicks === 0) {
        flushProse();
        inlineTicks = ticks;
      } else if (ticks === inlineTicks) {
        inlineTicks = 0;
      }
      normalized += line.slice(index, end);
      index = end;
    }
    flushProse();
    if (hasNewline) normalized += '\n';
  }
  return normalized;
}

function sourceContainsTrace(sourceText: string, traceText: string): boolean {
  if (sourceText.includes(traceText)) return true;
  return normalizeStrongPresentation(sourceText)
    .includes(normalizeStrongPresentation(traceText));
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
          if (!sourceContainsTrace(sourceText, source.text)) {
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function designDraftTraceReasons(
  candidates: readonly DesignDraftCandidate[],
  sourceText: string,
  systemDir: string,
): { reasons: string[]; validated: DesignDraftValidation[] } {
  const reasons: string[] = [];
  const validated: DesignDraftValidation[] = [];
  for (const candidate of candidates) {
    const requirementIds = candidate.requirements.map((requirement) => requirement.id);
    const requirementSet = new Set(requirementIds);
    if (requirementSet.size !== requirementIds.length) {
      reasons.push(`${candidate.candidateKey}: duplicate Design Request requirement ids`);
    }

    const traceCounts = new Map<string, number>();
    const systemIds: string[] = [];
    for (const trace of candidate.traces) {
      traceCounts.set(trace.requirementId, (traceCounts.get(trace.requirementId) ?? 0) + 1);
      if (!requirementSet.has(trace.requirementId)) {
        reasons.push(`${candidate.candidateKey}: extra design trace for ${trace.requirementId}`);
      }
      for (const source of trace.sources) {
        if (source.kind === 'source') {
          if (!sourceContainsTrace(sourceText, source.text)) {
            reasons.push(
              `${candidate.candidateKey}/${trace.requirementId}: source text not found: ${source.text}`,
            );
          }
        } else {
          systemIds.push(source.elementId);
        }
      }
    }
    for (const requirementId of requirementIds) {
      const count = traceCounts.get(requirementId) ?? 0;
      if (count !== 1) {
        reasons.push(
          `${candidate.candidateKey}: ${requirementId} has ${count} design trace entries (expected 1)`,
        );
      }
    }
    const uniqueSystemIds = [...new Set(systemIds)].sort(compareText);
    const resolved = resolveSystemContext(uniqueSystemIds, systemDir);
    for (const missing of resolved.missing) {
      reasons.push(`${candidate.candidateKey}: missing system element ${missing}`);
    }
    validated.push({ candidate, systemIds: uniqueSystemIds });
  }
  return { reasons, validated };
}

function sourceReference(intake: IntakeRecord) {
  const snapshot = intake.snapshot;
  const digest = digestDesignflowArtifact(
    Buffer.from(JSON.stringify(snapshot), 'utf8'),
    'application/json',
  );
  return {
    provider: 'github',
    externalId: `${snapshot.repository}#${snapshot.number}`,
    uri: snapshot.url,
    revision: snapshot.sourceUpdatedAt,
    digest,
  };
}

function systemReference(elementId: string) {
  return {
    provider: 'workflow-system',
    externalId: elementId,
  };
}

function referenceKey(reference: { provider: string; externalId: string }): string {
  return `${reference.provider}\0${reference.externalId}`;
}

/**
 * Deterministically derive the published Design Request from immutable source and draft traces.
 * No wall clock, Issue id counter, provider runtime, or filesystem path participates.
 */
export function buildDesignRequest(
  intake: IntakeRecord,
  draft: DesignDraftCandidate,
): DesignRequestType {
  const sourceRef = sourceReference(intake);
  const traces = new Map(draft.traces.map((trace) => [trace.requirementId, trace]));
  const systemIds = [...new Set(draft.traces.flatMap((trace) =>
    trace.sources.flatMap((source) => source.kind === 'system' ? [source.elementId] : []),
  ))].sort(compareText);
  const requestBody = {
    sourceRef,
    productIntent: {
      primaryOutcome: draft.productIntent.primaryOutcome,
      users: [...new Set(draft.productIntent.users)].sort(compareText),
      usageContext: draft.productIntent.usageContext,
    },
    requirements: [...draft.requirements]
      .sort((left, right) => compareText(left.id, right.id))
      .map((requirement) => {
        const trace = traces.get(requirement.id);
        if (!trace) {
          throw new Error(
            `${draft.candidateKey}: cannot build Design Request without trace ${requirement.id}`,
          );
        }
        const references = new Map<string, typeof sourceRef | ReturnType<typeof systemReference>>();
        for (const source of trace.sources) {
          const reference = source.kind === 'source'
            ? sourceRef
            : systemReference(source.elementId);
          references.set(referenceKey(reference), reference);
        }
        return {
          id: requirement.id,
          statement: requirement.statement,
          priority: requirement.priority,
          sourceRefs: [...references.values()]
            .sort((left, right) => compareText(referenceKey(left), referenceKey(right))),
        };
      }),
    constraints: [...draft.constraints]
      .sort((left, right) => compareText(left.id, right.id))
      .map((constraint) => ({ ...constraint })),
    targetSurfaces: [...new Set(draft.targetSurfaces)].sort(compareText),
    contextRefs: systemIds.map(systemReference),
    existingDesignSystemRef: draft.existingDesignSystemRef
      ? { ...draft.existingDesignSystemRef }
      : null,
    requestedAt: intake.snapshot.snapshotAt,
  };
  const identityDigest = digestDesignflowArtifact(
    Buffer.from(JSON.stringify({
      intakeKey: intake.intakeKey,
      candidateKey: draft.candidateKey,
      ...requestBody,
    }), 'utf8'),
    'application/json',
  );
  const request = {
    schemaVersion: '1.0' as const,
    requestId: `workflow-design-${identityDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    ...requestBody,
  };
  return DesignRequest.parse(request);
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

function selectDesignProvider(
  candidateKey: string,
  expected: DesignContractProviderType,
  config: HarnessConfig,
  reasons: string[],
): SelectedDesignProvider | null {
  // Config is JSON-backed at runtime, so parse the value again despite the TypeScript surface.
  const configured = (config.intake?.designProviders as
    | Readonly<Record<string, unknown>>
    | undefined)?.[candidateKey];
  if (configured === undefined) {
    reasons.push(`${candidateKey}: explicit design provider selection is required`);
    return null;
  }
  const parsed = DesignContractProvider.safeParse(configured);
  if (!parsed.success) {
    reasons.push(
      `${candidateKey}: invalid design provider selection; expected legacy-ui-design or designflow`,
    );
    return null;
  }
  if (parsed.data !== expected) {
    reasons.push(
      `${candidateKey}: selected ${parsed.data} provider cannot consume the `
      + `${expected === 'designflow' ? 'Designflow draft' : 'legacy UI candidate'}`,
    );
    return { candidateKey, provider: parsed.data };
  }
  return { candidateKey, provider: parsed.data };
}

function stableProviderSelections(
  selections: Iterable<SelectedDesignProvider>,
): PlanningEnrichmentRecordType['designProviderSelections'] {
  return [...selections]
    .sort((left, right) => compareText(left.candidateKey, right.candidateKey))
    .map((selection) => DesignProviderSelection.parse(selection));
}

function legacyDesignRevision(
  artifact: UiDesignArtifact,
  invocationKey: string,
) {
  const authority = legacyDesignAuthority(artifact, invocationKey);
  return LegacyDesignRevision.parse({
    candidateKey: authority.candidateKey,
    revisionId: authority.revisionId,
    artifactDigest: authority.artifactDigest,
    invocationKey: authority.invocationKey,
    artifact,
  });
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
  let validatedDrafts: DesignDraftValidation[] = [];
  const uiDesigns = opts.uiDesigns ?? {};
  const validatedUiDesigns = new Map<string, UiDesignValidation>();
  const selectedDesignProviders = new Map<string, SelectedDesignProvider>();
  if (!parsed.success) {
    reasons.push(`invalid planning output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  } else {
    reasons.push(...parsed.data.ambiguities.map((ambiguity) => `planning ambiguity: ${ambiguity}`));
    const supportedMethods = config.target
      ? supportedPlanningVerificationMethods(config.target)
      : null;
    const supportedMethodSet = supportedMethods
      ? new Set<VerificationMethod>(supportedMethods)
      : null;
    for (const candidate of parsed.data.candidates) {
      for (const field of ['include', 'exclude'] as const) {
        const invalid = candidate.contract.scope[field]
          .filter((pattern) => !isPlanningScopeGlob(pattern));
        if (invalid.length > 0) {
          reasons.push(
            `${candidate.candidateKey}: scope.${field} must contain only repo-relative `
            + `file globs understood by scope_check; invalid: ${invalid.join(', ')}`,
          );
        }
      }
      if (supportedMethodSet) {
        for (const criterion of candidate.contract.acceptanceCriteria) {
          if (!supportedMethodSet.has(criterion.verification.method)) {
            reasons.push(
              `${candidate.candidateKey}/${criterion.id}: verification method `
              + `${criterion.verification.method} is unavailable in the registered grader `
              + `profile (available: ${supportedMethods?.join(', ') ?? '(none)'})`,
            );
          }
        }
      }
    }
    const trace = traceReasons(
      parsed.data.candidates,
      `${intake.snapshot.title}\n${intake.snapshot.body}`,
      opts.systemDir,
    );
    reasons.push(...trace.reasons);
    validated = trace.validated;
    const draftTrace = designDraftTraceReasons(
      parsed.data.designDrafts,
      `${intake.snapshot.title}\n${intake.snapshot.body}`,
      opts.systemDir,
    );
    reasons.push(...draftTrace.reasons);
    validatedDrafts = draftTrace.validated;

    const allCandidateKeys = [
      ...parsed.data.candidates.map((candidate) => candidate.candidateKey),
      ...parsed.data.designDrafts.map((candidate) => candidate.candidateKey),
    ];
    if (new Set(allCandidateKeys).size !== allCandidateKeys.length) {
      reasons.push('candidateKey must be unique across final candidates and Designflow drafts');
    }

    for (const draft of parsed.data.designDrafts) {
      const selection = selectDesignProvider(
        draft.candidateKey,
        'designflow',
        config,
        reasons,
      );
      if (selection) selectedDesignProviders.set(draft.candidateKey, selection);
    }

    const plannedKeys = new Set(parsed.data.candidates.map((candidate) => candidate.candidateKey));
    for (const candidate of parsed.data.candidates) {
      if (requiresUiDesign(candidate)) {
        const selection = selectDesignProvider(
          candidate.candidateKey,
          'legacy-ui-design',
          config,
          reasons,
        );
        if (selection) selectedDesignProviders.set(candidate.candidateKey, selection);
        if (selection?.provider !== 'legacy-ui-design') {
          if (uiDesigns[candidate.candidateKey]) {
            reasons.push(
              `${candidate.candidateKey}: legacy UI artifact cannot be dual-written for `
              + 'a Designflow-selected candidate',
            );
          }
          continue;
        }
      }
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
  const designProviderSelections = stableProviderSelections(
    selectedDesignProviders.values(),
  );
  if (reasons.length > 0) {
    const record = store.addPlanningEnrichment(
      PlanningEnrichmentRecord.parse({
        id: store.nextId('ENRICH'), intakeKey, invocationKey: opts.invocationKey,
        status: 'needs-human-review', reasons, traces: [], issueIds: [],
        designProviderSelections,
        uiDesignCandidateKeys: [], uiDesignInvocationKeys, createdAt,
      }),
    );
    intake.status = 'needs-human-review';
    intake.updatedAt = createdAt;
    store.save();
    return record;
  }

  if (validatedDrafts.length > 0) {
    const designDrafts = validatedDrafts
      .sort((left, right) => compareText(left.candidate.candidateKey, right.candidate.candidateKey))
      .map(({ candidate, systemIds }) => DesignPlanningDraft.parse({
        candidate,
        systemIds,
        designRequest: buildDesignRequest(intake, candidate),
      }));
    const legacyDesigns = [...validatedUiDesigns.entries()]
      .flatMap(([candidateKey, design]) => {
        if (
          selectedDesignProviders.get(candidateKey)?.provider !== 'legacy-ui-design'
          || design.artifact === null
          || design.invocationKey === null
        ) return [];
        return [legacyDesignRevision(design.artifact, design.invocationKey)];
      })
      .sort((left, right) => compareText(left.candidateKey, right.candidateKey));
    const record = store.addPlanningEnrichment(
      PlanningEnrichmentRecord.parse({
        id: store.nextId('ENRICH'),
        intakeKey,
        invocationKey: opts.invocationKey,
        status: 'awaiting-design',
        reasons: [],
        traces: [],
        issueIds: [],
        pendingCandidates: validated,
        designDrafts,
        designProviderSelections,
        legacyDesigns,
        uiDesignCandidateKeys: legacyDesigns.map((design) => design.candidateKey),
        uiDesignInvocationKeys,
        createdAt,
      }),
    );
    intake.status = 'design-pending';
    intake.updatedAt = createdAt;
    store.save();
    return record;
  }

  const provider = resolvedGeneratorProvider(config);
  const issues = validated.map(({ candidate, systemIds }) => {
    const uiDesign = validatedUiDesigns.get(candidate.candidateKey);
    const designAuthority = uiDesign?.artifact && uiDesign.invocationKey
      ? legacyDesignAuthority(uiDesign.artifact, uiDesign.invocationKey)
      : null;
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
      designRequestId: null,
      designRevisionId: null,
      designBundleDigest: null,
      designAuthority,
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
      designProviderSelections,
      legacyDesigns: [...validatedUiDesigns.entries()]
        .flatMap(([candidateKey, design]) => {
          if (
            selectedDesignProviders.get(candidateKey)?.provider !== 'legacy-ui-design'
            || design.artifact === null
            || design.invocationKey === null
          ) return [];
          return [legacyDesignRevision(design.artifact, design.invocationKey)];
        })
        .sort((left, right) => compareText(left.candidateKey, right.candidateKey)),
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

export interface FinalizeDesignPlanningOptions {
  systemDir: string;
}

function observedDesignPlanningDecision(
  resolution: ApprovedDesignResolution,
  observedAt: string,
): DesignPlanningDecisionType {
  const reasonCodes = resolution.decisionGate.reasons.map((reason) => reason.code);
  const outcome = resolution.decisionGate.status === 'approved'
    ? 'approve'
    : reasonCodes.includes('decision-request-changes')
      ? 'request-changes'
      : reasonCodes.includes('decision-rejected')
        ? 'reject'
        : 'invalid';
  return DesignPlanningDecision.parse({
    candidateKey: resolution.candidateKey,
    requestId: resolution.decisionGate.requestId,
    revisionId: resolution.decisionGate.revisionId,
    previousRevisionId: resolution.reviewProjection?.identity.previousRevisionId ?? null,
    bundleDigest: resolution.decisionGate.bundleDigest,
    decisionId: resolution.decisionGate.decisionId,
    supersedesDecisionId: resolution.decisionGate.supersedesDecisionId,
    outcome,
    reasonCodes,
    observedAt,
  });
}

function appendDesignPlanningDecisions(
  existing: readonly DesignPlanningDecisionType[],
  resolutions: readonly ApprovedDesignResolution[],
  observedAt: string,
): DesignPlanningDecisionType[] {
  const history = [...existing];
  const keys = new Set(history.map((decision) => [
    decision.candidateKey,
    decision.requestId ?? '',
    decision.revisionId ?? '',
    decision.bundleDigest ?? '',
    decision.decisionId ?? '',
    decision.supersedesDecisionId ?? '',
    decision.outcome,
  ].join('\0')));
  for (const resolution of resolutions) {
    const decision = observedDesignPlanningDecision(resolution, observedAt);
    const key = [
      decision.candidateKey,
      decision.requestId ?? '',
      decision.revisionId ?? '',
      decision.bundleDigest ?? '',
      decision.decisionId ?? '',
      decision.supersedesDecisionId ?? '',
      decision.outcome,
    ].join('\0');
    if (!keys.has(key)) {
      history.push(decision);
      keys.add(key);
    }
  }
  return history;
}

/** Terminal fail-closed projection for a materialized but unsafe/invalid Designflow resolution. */
export function rejectDesignPlanningResolution(
  store: Store,
  intakeKey: string,
  reasons: readonly string[],
  designDecisionHistory?: readonly DesignPlanningDecisionType[],
): PlanningEnrichmentRecordType {
  const existing = store.planningEnrichmentFor(intakeKey);
  if (!existing) throw new Error(`No planning enrichment: ${intakeKey}`);
  if (existing.status !== 'awaiting-design') return existing;
  if (reasons.length === 0) {
    throw new Error('Design planning rejection requires at least one reason');
  }
  const intake = store.intakeByKey(intakeKey);
  if (!intake) throw new Error(`No intake record: ${intakeKey}`);

  const rejected = PlanningEnrichmentRecord.parse({
    ...existing,
    status: 'needs-human-review',
    reasons: [...reasons],
    traces: [],
    issueIds: [],
    approvedDesigns: [],
    capabilityCoverage: [],
    designDecisionHistory: designDecisionHistory ?? existing.designDecisionHistory,
  });
  store.replacePlanningEnrichment(rejected);
  intake.status = 'needs-human-review';
  intake.updatedAt = nowISO();
  store.save();
  return rejected;
}

/**
 * Explicitly reopen the provider lane after every selected Designflow candidate received a
 * complete request-changes decision. This never approves a revision and cannot resume rejects,
 * invalid bundles, or partial multi-candidate review.
 */
export function resumeDesignPlanningAfterRequestChanges(
  store: Store,
  intakeKey: string,
): PlanningEnrichmentRecordType {
  const existing = store.planningEnrichmentFor(intakeKey);
  if (!existing) throw new Error(`No planning enrichment: ${intakeKey}`);
  if (existing.status !== 'needs-human-review') {
    throw new Error(
      `Design planning resume requires needs-human-review, got ${existing.status}`,
    );
  }
  if (existing.issueIds.length > 0) {
    throw new Error('Design planning with allocated Issues cannot resume a provider revision');
  }
  if (existing.designDrafts.length === 0) {
    throw new Error('Design planning resume requires at least one Designflow draft');
  }
  const providerByCandidate = new Map(
    existing.designProviderSelections.map((selection) => [
      selection.candidateKey,
      selection.provider,
    ]),
  );
  for (const draft of existing.designDrafts) {
    if (providerByCandidate.get(draft.candidate.candidateKey) !== 'designflow') {
      throw new Error(
        `${draft.candidate.candidateKey}: Designflow revision cannot resume without `
        + 'the exclusive Designflow provider selection',
      );
    }
    const latest = [...existing.designDecisionHistory]
      .reverse()
      .find((decision) => decision.candidateKey === draft.candidate.candidateKey);
    if (
      latest?.outcome !== 'request-changes'
      || latest.requestId !== draft.designRequest.requestId
      || latest.revisionId === null
      || latest.bundleDigest === null
      || latest.decisionId === null
    ) {
      throw new Error(
        `${draft.candidate.candidateKey}: latest complete Designflow decision is not `
        + 'request-changes',
      );
    }
  }
  const intake = store.intakeByKey(intakeKey);
  if (!intake) throw new Error(`No intake record: ${intakeKey}`);
  const resumed = PlanningEnrichmentRecord.parse({
    ...existing,
    status: 'awaiting-design',
    reasons: [],
    issueIds: [],
    approvedDesigns: [],
    capabilityCoverage: [],
  });
  store.replacePlanningEnrichment(resumed);
  intake.status = 'design-pending';
  intake.updatedAt = nowISO();
  store.save();
  return resumed;
}

/**
 * Atomically project final Issue Contracts only after every Designflow draft has an approved,
 * consumer-validated bundle. Missing resolutions remain pending; explicit gate failures reject
 * the entire projection without allocating an Issue, counter, or capability edge.
 */
export function finalizeDesignPlanning(
  store: Store,
  config: HarnessConfig,
  intakeKey: string,
  resolutions: readonly ApprovedDesignResolution[],
  opts: FinalizeDesignPlanningOptions,
): PlanningEnrichmentRecordType {
  const existing = store.planningEnrichmentFor(intakeKey);
  if (!existing) throw new Error(`No planning enrichment: ${intakeKey}`);
  if (existing.status !== 'awaiting-design') return existing;
  const intake = store.intakeByKey(intakeKey);
  if (!intake) throw new Error(`No intake record: ${intakeKey}`);

  const resolutionByKey = new Map<string, ApprovedDesignResolution>();
  for (const resolution of resolutions) {
    if (resolutionByKey.has(resolution.candidateKey)) {
      throw new Error(`Duplicate approved design resolution: ${resolution.candidateKey}`);
    }
    resolutionByKey.set(resolution.candidateKey, resolution);
  }
  const draftKeys = new Set(existing.designDrafts.map((draft) => draft.candidate.candidateKey));
  for (const candidateKey of resolutionByKey.keys()) {
    if (!draftKeys.has(candidateKey)) {
      throw new Error(`Unexpected approved design resolution: ${candidateKey}`);
    }
  }
  if (existing.designDrafts.some((draft) =>
    !resolutionByKey.has(draft.candidate.candidateKey))) {
    return existing;
  }

  const designDecisionHistory = appendDesignPlanningDecisions(
    existing.designDecisionHistory,
    resolutions,
    nowISO(),
  );
  const reasons: string[] = [];
  const providerByCandidate = new Map(
    existing.designProviderSelections.map((selection) => [
      selection.candidateKey,
      selection.provider,
    ]),
  );
  for (const draft of existing.designDrafts) {
    if (providerByCandidate.get(draft.candidate.candidateKey) !== 'designflow') {
      reasons.push(
        `${draft.candidate.candidateKey}: Designflow draft has no exclusive explicit `
        + 'Designflow provider selection',
      );
    }
  }
  const legacyDesignByCandidate = new Map(
    existing.legacyDesigns.map((revision) => [revision.candidateKey, revision]),
  );
  for (const revision of existing.legacyDesigns) {
    if (providerByCandidate.get(revision.candidateKey) !== 'legacy-ui-design') {
      reasons.push(
        `${revision.candidateKey}: legacy artifact has no exclusive legacy provider selection`,
      );
    }
    const recomputed = legacyDesignAuthority(revision.artifact, revision.invocationKey);
    if (
      recomputed.revisionId !== revision.revisionId
      || recomputed.artifactDigest !== revision.artifactDigest
    ) {
      reasons.push(`${revision.candidateKey}: durable legacy design revision digest is stale`);
    }
  }
  const approvedDesigns: PlanningEnrichmentRecordType['approvedDesigns'] = [];
  const reconciliations: Array<{
    candidateKey: string;
    contract: DesignflowContractResult;
    reviewProjection: ApprovedDesignReviewProjection;
    result: Extract<CapabilityReconciliationResult, { status: 'accepted' }>;
  }> = [];
  for (const draft of existing.designDrafts) {
    const resolution = resolutionByKey.get(draft.candidate.candidateKey)!;
    const gate = resolution.decisionGate;
    if (gate.status !== 'approved') {
      if (gate.reasons.length === 0) {
        reasons.push(
          `${draft.candidate.candidateKey}: Design Decision gate did not approve the bundle`,
        );
      } else {
        reasons.push(...gate.reasons.map((reason) =>
          `${draft.candidate.candidateKey}: decision ${reason.code}: ${reason.message}`));
      }
      continue;
    }
    const contract = resolution.contract;
    if (contract === null) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved Design Decision has no consumed contract`,
      );
      continue;
    }
    if (
      gate.requestId !== contract.requestId
      || gate.revisionId !== contract.revisionId
      || gate.bundleDigest !== contract.bundleDigest
      || gate.decisionId === null
      || gate.decisionId !== contract.decisionId
      || gate.supersedesDecisionId !== (contract.decisionSupersedesDecisionId ?? null)
      || gate.reasons.length !== 0
      || contract.decisionVerdict !== 'approve'
    ) {
      reasons.push(
        `${draft.candidate.candidateKey}: Design Decision gate identity/verdict does not match `
        + 'the consumed approved contract',
      );
      continue;
    }
    if (resolution.reconciliation === null) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved capability revision has no workflow `
        + 'reconciliation',
      );
      continue;
    }
    const reviewProjection = resolution.reviewProjection;
    if (reviewProjection === null) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved Designflow revision has no WF-DF-005 `
        + 'review projection',
      );
      continue;
    }
    if (contract.requestId !== draft.designRequest.requestId) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved bundle requestId `
        + `${contract.requestId} does not match ${draft.designRequest.requestId}`,
      );
    }
    const expectedSourceDigest = digestDesignflowArtifact(
      Buffer.from(JSON.stringify(draft.designRequest), 'utf8'),
      'application/json',
    );
    if (contract.sourceDigest !== expectedSourceDigest) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved bundle sourceDigest `
        + `${contract.sourceDigest} does not match generated Design Request `
        + expectedSourceDigest,
      );
    }
    const projectedCapabilityIds = reviewProjection.capabilityDelta
      .map((capability) => capability.id)
      .filter((capabilityId): capabilityId is string =>
        typeof capabilityId === 'string')
      .sort(compareText);
    const contractCapabilityIds = [...contract.capabilityIds].sort(compareText);
    if (
      reviewProjection.identity.bundleId !== contract.bundleId
      || reviewProjection.identity.requestId !== contract.requestId
      || reviewProjection.identity.revisionId !== contract.revisionId
      || reviewProjection.digest.sourceDigest !== contract.sourceDigest
      || reviewProjection.digest.bundleDigest !== contract.bundleDigest
      || reviewProjection.ambiguities.length > 0
      || projectedCapabilityIds.length !== reviewProjection.capabilityDelta.length
      || projectedCapabilityIds.join('\0') !== contractCapabilityIds.join('\0')
    ) {
      reasons.push(
        `${draft.candidate.candidateKey}: review projection identity/content does not match `
        + 'the consumed approved contract',
      );
    }
    const latestRequestedRevision = [...existing.designDecisionHistory]
      .reverse()
      .find((decision) =>
        decision.candidateKey === draft.candidate.candidateKey
        && decision.outcome === 'request-changes');
    if (
      latestRequestedRevision
      && (
        latestRequestedRevision.requestId !== contract.requestId
        || latestRequestedRevision.revisionId === null
        || latestRequestedRevision.decisionId === null
        || latestRequestedRevision.revisionId === contract.revisionId
        || reviewProjection.identity.previousRevisionId
          !== latestRequestedRevision.revisionId
        || gate.supersedesDecisionId !== latestRequestedRevision.decisionId
      )
    ) {
      reasons.push(
        `${draft.candidate.candidateKey}: approved Human Design Decision does not directly `
        + 'supersede the latest request-changes decision for the same Design Request',
      );
    }
    approvedDesigns.push({
      candidateKey: draft.candidate.candidateKey,
      provider: 'designflow',
      providerRef: contract.providerRef,
      requestId: contract.requestId,
      revisionId: contract.revisionId,
      bundleDigest: contract.bundleDigest,
      decisionId: contract.decisionId ?? null,
      reviewProjection,
    });

    const reconciliation = reconcileDesignCapabilities(
      resolution.reconciliation,
      {
        requestId: contract.requestId,
        revisionId: contract.revisionId,
        bundleDigest: contract.bundleDigest,
        capabilityIds: contract.capabilityIds,
      },
      { systemDir: opts.systemDir },
    );
    if (reconciliation.status === 'rejected') {
      reasons.push(...reconciliation.reasons.map((reason) =>
        `${draft.candidate.candidateKey}: capability ${reason.code}: ${reason.message}`));
      continue;
    }
    const primary = reconciliation.plan.candidates
      .find((wrapper) =>
        wrapper.candidate.candidateKey === draft.candidate.candidateKey);
    if (!primary) {
      reasons.push(
        `${draft.candidate.candidateKey}: final reconciliation omits its primary candidate`,
      );
    } else {
      if (primary.candidate.area !== draft.candidate.area) {
        reasons.push(
          `${draft.candidate.candidateKey}: final area ${primary.candidate.area} `
          + `does not match draft area ${draft.candidate.area}`,
        );
      }
      if (primary.candidate.type !== draft.candidate.type) {
        reasons.push(
          `${draft.candidate.candidateKey}: final type ${primary.candidate.type} `
          + `does not match draft type ${draft.candidate.type}`,
        );
      }
    }
    reconciliations.push({
      candidateKey: draft.candidate.candidateKey,
      contract,
      reviewProjection,
      result: reconciliation,
    });
  }

  const candidateOwners = new Map<string, typeof reconciliations[number]>();
  const finalCandidateWrappers = reconciliations.flatMap((reconciliation) =>
    reconciliation.result.plan.candidates.map((wrapper) => {
      const candidateKey = wrapper.candidate.candidateKey;
      if (candidateOwners.has(candidateKey)) {
        reasons.push(`final candidateKey is duplicated across approved designs: ${candidateKey}`);
      } else {
        candidateOwners.set(candidateKey, reconciliation);
      }
      return wrapper;
    }));
  const legacyPendingCandidates = existing.pendingCandidates
    .filter((pending) =>
      providerByCandidate.get(pending.candidate.candidateKey) === 'legacy-ui-design');
  for (const pending of legacyPendingCandidates) {
    if (!legacyDesignByCandidate.has(pending.candidate.candidateKey)) {
      reasons.push(
        `${pending.candidate.candidateKey}: selected legacy provider has no durable UI artifact`,
      );
    }
    if (candidateOwners.has(pending.candidate.candidateKey)) {
      reasons.push(
        `${pending.candidate.candidateKey}: candidate cannot be authoritative in both `
        + 'legacy UI and Designflow revisions',
      );
    }
  }
  for (const revision of existing.legacyDesigns) {
    if (!existing.pendingCandidates.some((pending) =>
      pending.candidate.candidateKey === revision.candidateKey)) {
      reasons.push(`${revision.candidateKey}: legacy design has no pending candidate`);
    }
  }
  const finalCandidates = [
    ...finalCandidateWrappers.map((wrapper) => wrapper.candidate),
    ...legacyPendingCandidates.map((pending) => pending.candidate),
  ];
  for (const pending of existing.pendingCandidates) {
    if (providerByCandidate.get(pending.candidate.candidateKey) === 'legacy-ui-design') {
      continue;
    }
    const replacement = candidateOwners.get(pending.candidate.candidateKey)
      ?.result.plan.candidates.find((wrapper) =>
        wrapper.candidate.candidateKey === pending.candidate.candidateKey)
      ?.candidate;
    if (!replacement) {
      reasons.push(
        `approved capability reconciliation omits pending candidate `
        + pending.candidate.candidateKey,
      );
      continue;
    }
    if (
      replacement.area !== pending.candidate.area
      || replacement.type !== pending.candidate.type
    ) {
      reasons.push(
        `${pending.candidate.candidateKey}: reconciled area/type `
        + `${replacement.area}/${replacement.type} differs from draft `
        + `${pending.candidate.area}/${pending.candidate.type}`,
      );
    }
  }

  const trace = traceReasons(
    finalCandidates,
    `${intake.snapshot.title}\n${intake.snapshot.body}`,
    opts.systemDir,
  );
  reasons.push(...trace.reasons);

  if (reasons.length > 0) {
    return rejectDesignPlanningResolution(
      store,
      intakeKey,
      reasons,
      designDecisionHistory,
    );
  }

  const createdAt = nowISO();
  const provider = resolvedGeneratorProvider(config);
  const validatedByKey = new Map(
    trace.validated.map((validated) => [validated.candidate.candidateKey, validated]),
  );
  const wrapperByKey = new Map(
    finalCandidateWrappers.map((wrapper) => [wrapper.candidate.candidateKey, wrapper]),
  );
  for (const pending of legacyPendingCandidates) {
    wrapperByKey.set(pending.candidate.candidateKey, {
      candidate: pending.candidate,
      dependsOnCandidateKeys: [],
    });
  }
  const issueIdByCandidate = new Map<string, string>();
  for (const candidateKey of [...wrapperByKey.keys()].sort(compareText)) {
    issueIdByCandidate.set(candidateKey, store.nextId('ISSUE'));
  }

  const capabilityIdsByCandidate = new Map<string, Set<string>>();
  const capabilitySystemIdsByCandidate = new Map<string, Set<string>>();
  for (const reconciliation of reconciliations) {
    for (const binding of reconciliation.result.plan.bindings) {
      for (const edge of binding.issueEdges) {
        const capabilities = capabilityIdsByCandidate.get(edge.candidateKey)
          ?? new Set<string>();
        capabilities.add(binding.capabilityId);
        capabilityIdsByCandidate.set(edge.candidateKey, capabilities);
        const systemIds = capabilitySystemIdsByCandidate.get(edge.candidateKey)
          ?? new Set<string>();
        for (const systemElementId of binding.systemElementIds) {
          systemIds.add(systemElementId);
        }
        capabilitySystemIdsByCandidate.set(edge.candidateKey, systemIds);
      }
    }
  }

  const issues = [...wrapperByKey.keys()].sort(compareText).map((candidateKey) => {
    const owner = candidateOwners.get(candidateKey);
    const legacyDesign = legacyDesignByCandidate.get(candidateKey);
    const wrapper = wrapperByKey.get(candidateKey)!;
    const validated = validatedByKey.get(candidateKey)!;
    const capabilitySystemIds = capabilitySystemIdsByCandidate.get(candidateKey)
      ?? new Set<string>();
    if (legacyDesign) {
      const authority = legacyDesignAuthority(
        legacyDesign.artifact,
        legacyDesign.invocationKey,
      );
      return Issue.parse({
        id: issueIdByCandidate.get(candidateKey)!,
        type: wrapper.candidate.type,
        title: wrapper.candidate.title,
        area: wrapper.candidate.area,
        status: 'contract-drafted',
        assignedAgent: provider,
        contract: wrapper.candidate.contract,
        dependsOnSystem: validated.systemIds,
        dependsOnIssues: [],
        intakeKey,
        planningCandidateKey: candidateKey,
        uiDesign: legacyDesign.artifact,
        uiDesignInvocationKey: legacyDesign.invocationKey,
        designRequestId: null,
        designRevisionId: null,
        designBundleDigest: null,
        designCapabilityIds: [],
        designAuthority: authority,
        designReview: null,
        createdAt,
        updatedAt: createdAt,
      });
    }
    if (!owner) {
      throw new Error(`${candidateKey}: final candidate has no design authority`);
    }
    const decisionId = owner.contract.decisionId;
    if (!decisionId) {
      throw new Error(`${candidateKey}: approved Designflow contract has no decisionId`);
    }
    return Issue.parse({
      id: issueIdByCandidate.get(candidateKey)!,
      type: wrapper.candidate.type,
      title: wrapper.candidate.title,
      area: wrapper.candidate.area,
      status: 'contract-drafted',
      assignedAgent: provider,
      contract: wrapper.candidate.contract,
      dependsOnSystem: [...new Set([
        ...validated.systemIds,
        ...capabilitySystemIds,
      ])].sort(compareText),
      dependsOnIssues: wrapper.dependsOnCandidateKeys
        .map((dependency) => issueIdByCandidate.get(dependency)!)
        .sort(compareText),
      intakeKey,
      planningCandidateKey: candidateKey,
      uiDesign: null,
      uiDesignInvocationKey: null,
      designRequestId: owner.contract.requestId,
      designRevisionId: owner.contract.revisionId,
      designBundleDigest: owner.contract.bundleDigest,
      designCapabilityIds: [...(capabilityIdsByCandidate.get(candidateKey)
        ?? new Set<string>())].sort(compareText),
      designAuthority: {
        provider: 'designflow',
        providerRef: owner.contract.providerRef,
        candidateKey,
        requestId: owner.contract.requestId,
        revisionId: owner.contract.revisionId,
        bundleDigest: owner.contract.bundleDigest,
        decisionId,
      },
      designReview: owner.reviewProjection,
      createdAt,
      updatedAt: createdAt,
    });
  });
  for (const issue of issues) store.addIssue(issue);

  const capabilityCoverage = reconciliations.flatMap((reconciliation) =>
    reconciliation.result.plan.bindings.flatMap((binding) =>
      binding.issueEdges.map((edge) => CapabilityCoverageProjection.parse({
        capabilityId: binding.capabilityId,
        requestId: binding.requestId,
        revisionId: binding.revisionId,
        bundleDigest: binding.bundleDigest,
        issueId: issueIdByCandidate.get(edge.candidateKey),
        criterionId: edge.criterionId,
        systemElementIds: binding.systemElementIds,
        apiOperationIds: binding.apiOperationIds,
      })))).sort((left, right) =>
    compareText(
      `${left.capabilityId}\0${left.issueId}\0${left.criterionId}`,
      `${right.capabilityId}\0${right.issueId}\0${right.criterionId}`,
    ));
  const traces = trace.validated.flatMap(({ candidate }) =>
    candidate.traces.map((candidateTrace) => ({
      candidateKey: candidate.candidateKey,
      ...candidateTrace,
    })),
  );
  const accepted = PlanningEnrichmentRecord.parse({
    ...existing,
    status: 'accepted',
    reasons: [],
    traces,
    issueIds: issues.map((issue) => issue.id),
    approvedDesigns: [...approvedDesigns]
      .sort((left, right) => compareText(left.candidateKey, right.candidateKey)),
    capabilityCoverage,
    designDecisionHistory,
    designProviderSelections: [...wrapperByKey.keys()]
      .sort(compareText)
      .map((candidateKey) => ({
        candidateKey,
        provider: legacyDesignByCandidate.has(candidateKey)
          ? 'legacy-ui-design' as const
          : 'designflow' as const,
      })),
  });
  store.replacePlanningEnrichment(accepted);
  intake.status = 'ready';
  intake.storeIssueIds = accepted.issueIds;
  intake.updatedAt = createdAt;
  store.save();
  return accepted;
}
