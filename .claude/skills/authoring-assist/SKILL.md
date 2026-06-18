---
name: authoring-assist
description: 機能の WHAT（受け入れ要件）をハーネスの契約形式で著述する補助。spec.md に名前付き Given/When/Then の受け入れ基準（安定 AC-ID 付き）、acceptance.yaml に severity と自動採点 verification、自動採点できない要件は manual-requirements.md へ分離する。新機能の定義、受け入れ基準の作成・編集、spec.md / acceptance.yaml の作成、設計・署名前の機能整備のときに使う。
allowed-tools: Read, Write, Edit, Bash
---

# Authoring assist

Help a human author a feature spec that is a valid input contract for the design layer.
You assist; **code enforces** integrity (ADR-0005). The human owns the WHAT and signs.

## What to do

1. Draw out the WHAT: user story (who / what / why), sub-features, preconditions. Do not design HOW.
2. Write `spec.md` from the template `templates/feature-spec.md`:
   - Acceptance criteria are **named Given/When/Then scenarios**, each with a stable AC-ID
     (`AC-<FEATURE>-NNN`) in a leading bold anchor: `- **[AC-FOO-001] 正常系: name**`.
   - Cover normal / error / resilience paths, not just the happy path.
   - No frontmatter; no YAML body. Reference shared domain/data/status from `_system/` — do not embed.
3. For each AC-ID, propose `severity` + `verification` (auto grader `method` + `expected`) in
   `acceptance.yaml` using the template `templates/acceptance.yaml`. Put anything that can't be
   auto-graded into `manual-requirements.md` instead.
4. Run the integrity check and fix until it passes (from the repo root):
   `npx tsx .claude/skills/authoring-assist/scripts/check-spec.ts <epic-dir>`
   It enforces bidirectional coverage (spec ⇔ acceptance), no duplicate AC-IDs, and no `manual` method.
5. Stop. The human reviews and signs the acceptance criteria (`contract-approved`). You do not sign.

Format details: `.claude/skills/authoring-assist/references/format.md`.

## Red lines

- Do not write `spec.md` as YAML, and do not add frontmatter (meta/signature live in the epic state object).
- Do not write HOW (DB schema, API, algorithms, component design) — that is the design layer's job.
- Do not renumber or reuse AC-IDs.
- Do not put `manual` methods in `acceptance.yaml` (they belong in `manual-requirements.md`).
- Do not embed domain/data/status that belongs in the shared `_system/` layer — reference it.
