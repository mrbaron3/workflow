/** Provider-neutral AgentInvocation identity and durable recorder (FEAT-013). */
import {
  AgentInvocation,
  type AgentProvider,
  type InvocationOutcome,
  type InvocationRole,
  type RevisionBinding,
} from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';

interface InvocationCoordinatesBase {
  subjectId: string;
  issueId?: string | null;
  sampleIndex?: number | null;
  attempt: number;
  role: InvocationRole;
  perspective?: string | null;
}

type UnboundInvocation = {
  prId?: string | null;
  revisionId?: null;
  headSha?: null;
};

export type InvocationCoordinates =
  | (InvocationCoordinatesBase & RevisionBinding & { prId: string })
  | (InvocationCoordinatesBase & UnboundInvocation);

export type InvocationProvenanceInput = InvocationCoordinates & {
  provider: AgentProvider;
  model?: string | null;
  prompt: string;
  outcome: InvocationOutcome;
  createdAt?: string;
};

/** Stable, inspectable logical key. Encoding keeps separators in user/remote ids unambiguous. */
export function invocationKey(coordinates: InvocationCoordinates): string {
  const segment = (value: string | number | null | undefined): string =>
    value === null || value === undefined ? '-' : encodeURIComponent(String(value));
  const revisionBound = coordinates.revisionId != null || coordinates.headSha != null;
  return [
    revisionBound ? 'invocation:v2' : 'invocation:v1',
    segment(coordinates.subjectId),
    segment(coordinates.issueId),
    segment(coordinates.prId),
    segment(coordinates.sampleIndex),
    segment(coordinates.attempt),
    segment(coordinates.role),
    segment(coordinates.perspective),
    ...(revisionBound
      ? [segment(coordinates.revisionId), segment(coordinates.headSha)]
      : []),
  ].join(':');
}

export class InvocationProvenanceConflictError extends Error {
  constructor(readonly key: string, readonly differingFields: string[]) {
    super(`Invocation provenance conflict for ${key}: ${differingFields.join(', ')}`);
    this.name = 'InvocationProvenanceConflictError';
  }
}

const PROVENANCE_FIELDS = [
  'subjectId',
  'issueId',
  'prId',
  'sampleIndex',
  'attempt',
  'role',
  'perspective',
  'provider',
  'model',
  'prompt',
  'outcome',
  'revisionId',
  'headSha',
] as const satisfies readonly (keyof AgentInvocation)[];

/**
 * Insert one logical invocation exactly once. Identical resume writes are no-ops; any change to
 * provenance fails closed before counters or the existing record are mutated.
 */
export function recordAgentInvocation(store: Store, input: InvocationProvenanceInput): AgentInvocation {
  const revisionBound = input.revisionId != null || input.headSha != null;
  if (revisionBound) {
    if (!input.prId || !input.revisionId || !input.headSha) {
      throw new Error('revision-bound invocation requires prId, revisionId, and headSha');
    }
    const revision = store.db.prRevisions.find((row) => row.id === input.revisionId);
    if (!revision) {
      throw new Error(`No such PR revision: ${input.revisionId}`);
    }
    if (revision.prId !== input.prId || revision.headSha !== input.headSha) {
      throw new Error(
        `invocation revision ${input.revisionId} does not match PR ${input.prId} at ${input.headSha}`,
      );
    }
  }
  const key = invocationKey(input);
  const candidate = {
    invocationKey: key,
    subjectId: input.subjectId,
    issueId: input.issueId ?? null,
    prId: input.prId ?? null,
    sampleIndex: input.sampleIndex ?? null,
    attempt: input.attempt,
    role: input.role,
    perspective: input.perspective ?? null,
    provider: input.provider,
    model: input.model ?? null,
    prompt: input.prompt,
    outcome: input.outcome,
    revisionId: input.revisionId ?? null,
    headSha: input.headSha ?? null,
  };
  const existing = store.invocationByKey(key);
  if (existing) {
    const differing = PROVENANCE_FIELDS.filter((field) => existing[field] !== candidate[field]);
    if (differing.length > 0) throw new InvocationProvenanceConflictError(key, differing);
    return existing;
  }
  return store.addAgentInvocation(
    AgentInvocation.parse({
      id: store.nextId('INVOKE'),
      ...candidate,
      createdAt: input.createdAt ?? nowISO(),
    }),
  );
}
