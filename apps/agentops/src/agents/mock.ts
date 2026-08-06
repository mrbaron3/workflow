/**
 * MockAgentRunner — a deterministic stand-in for a real coding agent.
 *
 * It does NOT call a model. It simulates one well enough to exercise the entire
 * loop: most issues partially succeed on the first attempt, fail a blocker or two,
 * then converge once a Repair Brief tells it exactly what to fix. All behaviour is
 * derived from a string seed, so a given (issue, sample, attempt) always yields the
 * same artifact — which is what makes pass@k / pass^k meaningful across re-runs.
 */

import type { AgentRunner } from './runner.js';
import type { BuildArtifact, GenerateInput } from '../domain/artifact.js';
import type { AgentProvider } from '../domain/schema.js';
import { hashUnit } from '../util/hash.js';

/** Base per-criterion success probability for the mock "agent". */
const BASE_COMPETENCE = 0.8;

export class MockAgentRunner implements AgentRunner {
  readonly agent: AgentProvider = 'mock';

  async generate(input: GenerateInput): Promise<BuildArtifact> {
    const { issue, contract, sampleIndex, attempt, repairBrief } = input;
    const seed = `${issue.id}|s${sampleIndex}|a${attempt}`;
    const targeted = new Set(repairBrief?.findings.map((f) => f.criterionId) ?? []);

    // Decide up front (deterministically) whether THIS sample will ever converge.
    // Some samples carry a "stubborn" blocker the agent can't crack within maxRepairs —
    // that's what keeps eventual success below 100% so pass^k diverges from pass@k and
    // the instability metric means something.
    const easiness = 0.7 + 0.22 * hashUnit(`${issue.id}|easiness`); // 0.70..0.92
    const willConverge = hashUnit(`${issue.id}|s${sampleIndex}|converge`) < easiness;
    const blockerAcs = contract.acceptanceCriteria.filter((a) => a.severity === 'blocker');
    const stubbornAc =
      !willConverge && blockerAcs.length > 0 ? blockerAcs[blockerAcs.length - 1]!.id : null;

    // --- acceptance criteria -------------------------------------------------
    const satisfied: Record<string, boolean> = {};
    for (const ac of contract.acceptanceCriteria) {
      // The stubborn criterion never gets fixed, even when the repair brief targets it.
      if (ac.id === stubbornAc) {
        satisfied[ac.id] = false;
        continue;
      }
      // On a repair attempt, criteria that weren't flagged were already passing —
      // carry them forward so repair makes monotonic progress (no random regressions).
      if (attempt > 1 && !targeted.has(ac.id)) {
        satisfied[ac.id] = true;
        continue;
      }
      const roll = hashUnit(`${seed}|${ac.id}`);
      let competence = BASE_COMPETENCE + 0.1 * (attempt - 1);
      if (targeted.has(ac.id)) competence += 0.45; // explicitly told to fix this one
      satisfied[ac.id] = roll < competence;
    }

    // --- hard gates ----------------------------------------------------------
    // Gate flakes only appear on the first attempt; repair always cleans them up.
    const buildPasses = true;
    const typecheckPasses = attempt > 1 || hashUnit(`${seed}|typecheck`) > 0.06;
    const unitTestsPass = attempt > 1 || hashUnit(`${seed}|unit`) > 0.12;
    const apiTestsPass = attempt > 1 || hashUnit(`${seed}|api`) > 0.1;
    const hasTests = true;
    const secretsLeaked = false; // mock never leaks secrets (keeps the demo clean)

    // Scope creep: occasional AI-antipattern on first attempt only.
    const scopeViolations =
      attempt === 1 && hashUnit(`${seed}|scope`) < 0.12
        ? ['src/unrelated/touched-by-mistake.ts']
        : [];

    // --- qualitative scores --------------------------------------------------
    const q = (k: string) =>
      Math.min(1, 0.62 + 0.25 * hashUnit(`${seed}|${k}`) + 0.05 * (attempt - 1));

    const notes: string[] = [];
    if (repairBrief) {
      notes.push(`Applied repair brief from ${repairBrief.fromEvalRunId}.`);
      for (const ins of repairBrief.instructions) notes.push(`fixed: ${ins}`);
    } else {
      notes.push(`Implemented "${issue.title}" from contract.`);
    }

    return {
      branch: `agent/${issue.id.toLowerCase()}-s${sampleIndex}`,
      summary: `${this.agent} build for ${issue.id} (sample ${sampleIndex}, attempt ${attempt})`,
      filesChanged: [
        `src/features/${issue.area}/${issue.id.toLowerCase()}.ts`,
        `test/${issue.id.toLowerCase()}.test.ts`,
        ...scopeViolations,
      ],
      satisfied,
      buildPasses,
      typecheckPasses,
      unitTestsPass,
      apiTestsPass,
      hasTests,
      secretsLeaked,
      scopeViolations,
      quality: {
        codeQuality: q('cq'),
        testQuality: q('tq'),
        ux: q('ux'),
        accessibility: q('a11y'),
      },
      notes,
    };
  }
}
