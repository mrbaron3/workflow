/**
 * Record an attested human HOW-intervention (autonomy axis — the ⑥⑦ accounting).
 *
 * The single mutation point for intervention facts. The WHAT/HOW boundary lives in the
 * VOCABULARY (INTERVENTION_KINDS): judgment points — adopt / assign / sign / decide /
 * label — have no kind, so they cannot be recorded and never reach the instruments.
 * Only explicit, attested records become facts; nothing infers an intervention from
 * other store state (⑦'s lesson — a guessing diagnostician produces false signals).
 *
 * Issue STATUS is deliberately not a precondition: the ⑥⑦ conditional approvals
 * happened before the instruments existed, and a released issue must accept
 * retroactive records (AC-INTV-004) or the autonomy axis starts from the lie
 * "zero interventions".
 */

import { Intervention, INTERVENTION_KINDS } from '../domain/schema.js';
import { nowISO, type Store } from '../store/store.js';

export { INTERVENTION_KINDS };

export interface InterventionInput {
  issueId: string;
  kind: string;
  reason: string;
}

export function recordIntervention(store: Store, input: InterventionInput): Intervention {
  store.requireIssue(input.issueId); // must exist; status never checked (retroactivity)
  if (!(INTERVENTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(
      `unknown intervention kind '${input.kind}' — judgment points are not interventions; ` +
        `valid kinds: ${INTERVENTION_KINDS.join(', ')}`,
    );
  }
  if (!input.reason || !input.reason.trim()) {
    throw new Error('an intervention needs a reason — attest WHY the human touched the HOW');
  }
  const fact = Intervention.parse({
    id: store.nextId('INTV'),
    issueId: input.issueId,
    kind: input.kind,
    reason: input.reason,
    createdAt: nowISO(),
  });
  store.addIntervention(fact);
  store.save(); // an attested fact is durable immediately (store = SoT, ARCH-evaluation-008)
  return fact;
}
