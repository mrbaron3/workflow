---
name: to-spec
description: 機能の受け入れ要件（spec.md / acceptance.yaml）を著すのを助ける。新機能の定義、受け入れ基準の作成・編集、設計・署名前の機能整備のときに使う。
when_to_use: 「spec を書きたい / 受け入れ基準（Given/When/Then）を作る / acceptance.yaml を整える / 機能を定義する / 設計・署名の前に詰める」といった依頼のとき。設計層（system 層＝ドメイン/アーキ/データは to-system-design、spec の slice 分解は to-detail-design）には使わない。
argument-hint: [spec-dir]
allowed-tools: Read, Write, Edit, Bash
---

# To spec

Help a human turn an **already-decided** feature direction into a feature spec that is a valid input
contract for the design layer. You assist; code enforces integrity (check-spec.ts / the signing gate).
The human owns the WHAT and signs — never sign, and never relax a criterion, yourself.

This is a collaborative loop, not a one-shot generation: propose, surface what you cannot grade, let
the human confirm. Keep `spec.md` human-readable; push grader detail into `acceptance.yaml`.

## 1. Intake — consume the decision, don't re-elicit it

If an upstream decision doc exists (brainstorm result, draft, or notes — ask for the path, or look
under `docs/draft/_brainstorm/`), read it and treat its decided content as the source. Project it:

| Upstream doc element | Maps to in spec |
| --- | --- |
| purpose | user story |
| chosen direction / success criteria | acceptance criteria |
| constraints / assumptions | preconditions / red lines |
| open questions | gaps to close before signing |

Re-elicit only what the doc leaves open. With no such doc, draw the WHAT out from scratch (who / what
/ why, sub-features, preconditions). Either way: **WHAT only, never HOW.**

A spec is **granularity-independent** — it can be a one-field feature or a whole subsystem. Don't carve
it into epics or slices; that decomposition is downstream. Keep one spec to a single
**coherent, human-signable capability**: if the ask is roadmap-sized (a whole product), say so and split
it into several specs upstream (north-star / roadmap), don't force it into one spec.

Read the existing **system layer** (`_system/<context>/ubiquitous-language.md`, `domain-model.md`,
`data-model.md`, `architecture.md`) and treat it as fixed constraints: **reference** the ubiquitous
language, business statuses, and shared domain/data — never copy them into the spec. Record the ids you
reference (`dependsOn`) and any past AC this spec replaces (`supersedes`) in `acceptance.yaml`, not in
`spec.md` — keeping `[AC-…]` brackets out of the prose the coverage/signing parsers scan. Duplication
drifts, and HOW (schema, API, algorithm) belongs to the design layer, not here.

## 2. Write `spec.md` from the template

Template: [assets/feature-spec.md](assets/feature-spec.md). Write it into the spec's directory
(`<spec-dir>`), beside the `acceptance.yaml` of step 3 — that directory is this spec's authored
contract, version-pinned on signing.

The real work is contract-shaping the decided content into named Given/When/Then scenarios, each with
a stable AC-ID. An exploratory doc almost always hands you only the happy path; the value you add is
the paths money and trust hinge on — **error, resilience, boundary, and concurrency** (timeout
recovery, double-credit prevention, reconnect, partial failure). The template is self-documenting;
follow its leading comments rather than restating them.

Phrase every scenario as what an outside observer — or an automated grader — can see: a notification
arrives, a status becomes X, an amount is credited exactly once. Describe the observed *effect*, not
the machinery that produces it (scheduling, enqueueing, the provider call, the worker). Naming the
mechanism is HOW: it dates the spec and pre-decides the design.

## 3. Propose grading in `acceptance.yaml`

Template: [assets/acceptance.yaml](assets/acceptance.yaml). For each AC-ID propose a `severity` and a
`verification` whose `method` is from the auto-gradable set — build, typecheck, unit_test, api_test,
db_state_check, playwright, secrets_scan, scope_check, llm_rubric — with a concrete, checkable
`expected`. When a requirement genuinely resists auto-grading, don't quietly drop it: name it in chat
(which AC, why) and let the human decide how to handle it — the auto-gradable set is the whole menu, so
anything that doesn't fit belongs in that conversation, not forced into a row.

A completion proof only a human eye can confirm — a visual demo, "check it on a real device" — is an
ungradeable requirement, not an acceptance criterion. Surface it like any other ungradeable item; never
let it sit in the spec's completion conditions as if it were a passing gate.

## 4. Self-check before handoff

Run the same deterministic lint the signing gate / pre-commit enforce, until it passes. The skill
doesn't own this gate — code does (skill-independent); you run it early to catch AC-ID
coverage / numbering breaks before a human reviews.

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-spec.ts <spec-dir>
```

## 5. Stop

The human reviews and signs the acceptance criteria (`contract-approved`). You do not sign.

---

Templates live beside this skill under `assets/` and are self-documenting. The integrity invariants
are owned by `scripts/check-spec.ts` (which vendors `src/authoring/lint.ts`), not by any prose doc —
so this file never restates the rules. Non-obvious judgment calls the template doesn't cover — spec
scope (cohesion, not carving), meta-features that define a contract, greenfield forward-references,
process-vs-AC altitude — live in [references/edge-cases.md](references/edge-cases.md), loaded on demand.
