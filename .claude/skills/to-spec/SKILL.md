---
name: to-spec
description: 機能の受け入れ要件を著すのを助ける。新機能の定義、受け入れ基準（spec.md）と採点定義（acceptance.yaml）の作成・編集、設計・署名前の機能整備のときに使う。
allowed-tools: Read, Write, Edit, Bash
---

# To spec

Help a human turn an already-decided feature direction into a feature spec that is a valid input
contract for the design layer. You assist; code enforces integrity (check-spec.ts).
The human owns the WHAT and signs.

## What to do

### 1. Intake — consume the decision, don't re-elicit it

If an upstream decision doc exists (brainstorm result, draft, or notes — ask for the path, or look
under `docs/draft/_brainstorm/`), read it and treat its decided content as the source. Project it into the
spec along these lines:

| Upstream doc element | Maps to in spec |
| --- | --- |
| purpose | user story |
| chosen direction / success criteria | acceptance criteria |
| constraints / assumptions | preconditions / red lines |
| open questions | gaps to close before signing |

Re-elicit only what the doc leaves open. If there is no such doc, draw the WHAT out from scratch
(who / what / why, sub-features, preconditions). Either way: **WHAT only, never HOW.**

A spec is **granularity-independent** — it can be a one-field feature or a whole subsystem. Don't carve
it into epics or slices; that decomposition is downstream (ADR-0008). Keep one spec to a single
**coherent, human-signable capability**: if the ask is roadmap-sized (a whole product), say so and split
it into several specs upstream (north-star / roadmap), don't force it into one spec.

### 2. Write `spec.md` from `assets/feature-spec.md`

Write into the spec's directory — call it `<spec-dir>` — alongside the `acceptance.yaml` of step 3.
(The spec dir is the home of this spec's authored contract; the spec state object pins its files on
signing.) The genuine work is contract-shaping the decided content: named Given/When/Then scenarios
with stable AC-IDs, covering the error / resilience paths an exploratory doc rarely has — not just the
happy path. The template is self-documenting; follow its leading comments, don't restate them here.

### 3. Propose grading in `acceptance.yaml`

For each AC-ID, propose `severity` + `verification` (auto grader `method` + `expected`), using
`assets/acceptance.yaml`. When a requirement resists auto-grading, don't file it away silently —
surface it in chat (which requirement, why) and let the human decide how to handle it.

### 4. Self-check before handoff

Run the same deterministic lint the signing gate / pre-commit enforce, from the repo root, and fix
until it passes. The skill doesn't own this gate — code does (skill-independent); you
run it early only to catch AC-ID coverage / numbering breaks before a human reviews.

```bash
npx tsx .claude/skills/to-spec/scripts/check-spec.ts <spec-dir>
```

### 5. Stop

The human reviews and signs the acceptance criteria (`contract-approved`). You do not sign.

---

Templates live next to this skill under `assets/` and are self-documenting. Integrity invariants are
the source of truth in `scripts/check-spec.ts` (and `src/authoring/lint.ts`), not in any prose doc.
Non-obvious judgment calls the template doesn't cover — spec scope (cohesion, not carving), meta-features
that define a contract, greenfield forward-references, process-vs-AC altitude — live in
[references/edge-cases.md](references/edge-cases.md), loaded on demand.
