import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FindingLineageRef = z.string()
  .regex(/^finding-origin-v1:[0-9a-f]{64}$/);
export type FindingLineageRef = z.infer<typeof FindingLineageRef>;

export interface FindingOriginCoordinates {
  runId: string;
  prId: string;
  headSha: string | null;
  attempt: number;
  perspective: string;
}

/**
 * Immutable reviewer-visible identity for the first occurrence of a finding.
 * The mutable criterion, prose, reproduction, and evidence payload are absent.
 */
export function findingOriginRef(
  coordinates: FindingOriginCoordinates,
  findingIndex: number,
): FindingLineageRef {
  if (!Number.isSafeInteger(findingIndex) || findingIndex < 0) {
    throw new Error('finding index must be a non-negative safe integer');
  }
  const digest = createHash('sha256').update(JSON.stringify({
    runId: coordinates.runId,
    prId: coordinates.prId,
    headSha: coordinates.headSha,
    attempt: coordinates.attempt,
    perspective: coordinates.perspective,
    findingIndex,
  })).digest('hex');
  return FindingLineageRef.parse(`finding-origin-v1:${digest}`);
}
