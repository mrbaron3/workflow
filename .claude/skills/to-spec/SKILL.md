---
name: to-spec
description: 機能の WHAT（受け入れ要件）をハーネスの契約形式で著述する補助。spec.md に名前付き Given/When/Then の受け入れ基準（安定 AC-ID 付き）、acceptance.yaml に severity と自動採点 verification、自動採点できない要件はチャットで指摘する。新機能の定義、受け入れ基準の作成・編集、spec.md / acceptance.yaml の作成、設計・署名前の機能整備のときに使う。
allowed-tools: Read, Write, Edit, Bash
---

# To spec

Help a human turn an already-decided feature direction into a feature spec that is a valid input
contract for the design layer. You assist; **code enforces** integrity (check-spec.ts / ADR-0005).
The human owns the WHAT and signs.

## What to do

1. **Intake — consume the decision, don't re-elicit it.** If an upstream decision doc exists
   (a brainstorm result, draft, or notes — ask for the path, or look under `draft/_brainstorm/`),
   read it and treat its decided content as the source. Project it into the spec:
   purpose → user story, chosen direction / success criteria → acceptance criteria,
   constraints / assumptions → preconditions and red lines, open questions → gaps to close before
   signing. Re-elicit **only** what the doc leaves open. If there is no such doc, draw the WHAT out
   from scratch (who / what / why, sub-features, preconditions). Either way: **WHAT only, never HOW.**
2. Write `spec.md` from `templates/feature-spec.md`. The genuine work here is contract-shaping the
   decided content: turn it into named Given/When/Then scenarios with stable AC-IDs, and cover the
   error / resilience paths an exploratory doc rarely has — not just the happy path. Format rules
   live in `references/format.md`; follow the template, don't restate it here.
3. For each AC-ID, propose `severity` + `verification` (auto grader `method` + `expected`) in
   `acceptance.yaml` (template: `templates/acceptance.yaml`). When a requirement resists
   auto-grading, **don't file it away silently — surface it in chat** (which requirement, why it
   can't be auto-graded) and let the human decide how to handle it.
4. Run the integrity check and fix until it passes (from the repo root):
   `npx tsx .claude/skills/to-spec/scripts/check-spec.ts <epic-dir>`
5. Stop. The human reviews and signs the acceptance criteria (`contract-approved`). You do not sign.

Format details: `.claude/skills/to-spec/references/format.md`.
