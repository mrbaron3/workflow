---
name: to-system-design
description: 設計層の system 層（ユビキタス言語・ドメイン・アーキテクチャ・データ）を境界コンテキスト単位で著す・拡張する。spec 差分・トップダウン要求・既存コードからの逆生成のいずれの入力からでも、観点を依存順で設計する（既定はインライン、規模が大きいときだけ観点ごとの専用エージェントに分散）。署名済み spec が無くても使える。
when_to_use: 基本設計・方式設計・アーキテクチャ・ドメインモデル・ユビキタス言語・モジュール境界・seam・DB設計・データモデル・スキーマ設計・正規化・マイグレーションを作るとき。署名済み spec が無くてもよい（トップダウンの macro 据え／既存実装からの逆生成も本スキルの仕事）。署名済み spec を Issue/PR に分解するのは to-detail-design を使う。
argument-hint: "[source: <spec-dir> | code <path> | requirement <doc>] [--context <ctx>]"
allowed-tools: Read, Write, Edit, Bash, Task
arguments: source
---

# To system design

Own the **system layer** — the four macro views of a bounded context: ubiquitous **language**, **domain**
model, **architecture**, and **data** model — as an *additive single source of truth*. You coordinate;
per-view modelers author; `scripts/check-system-design.ts` enforces the structural invariants. The human
owns the WHAT and signs — you never sign, never edit `spec.md` / `acceptance.yaml`.

The system layer is **state, not a spec's delta**: a bounded context is designed and owned across specs —
and across the lifetime of the code — not re-derived each time. It lives under `_system/<context>/`; each
view has its own additive id space (`LANG/DOM/ARCH/DATA-<CTX>-NNN`, never renumbered/rewritten). Read the
whole relevant context and add to it.

## The output is fixed; the input is pluggable

The four-view output contract never changes. **Where the knowledge comes from** is what varies — that is
why this skill is *not* welded to `to-spec`. Two mechanisms cover three entry modes:

| Mode | Source you're given | Mechanism | Anchor |
| --- | --- | --- | --- |
| **spec-driven** | a signed `spec.md` directory | author / extend | records `design-delta.md` (reads/extends + affected AC-IDs) against the spec |
| **top-down** | a requirement / north-star / roadmap (no spec yet) | author / extend | seeds the macro layer first; the delta has no AC linkage |
| **reverse** | an existing **codebase** | distil-from-code | a **draft proposal** for human review — never a direct `_system/` write |

Detect the mode from the source. Author/extend (spec-driven + top-down) writes additively into
`_system/<ctx>/` and differs only by whether a spec anchors the delta. Reverse distils a draft and stages
it — its discipline is [references/reverse.md](references/reverse.md). When you can't tell which context a
change belongs to, or whether it's new or existing, read the relevant `_system/<ctx>/` first; don't guess.

## Run the views in dependency order — inline by default

The four views are orthogonal concerns but not independent: language fixes the words, domain models the
entities in them, and architecture and data each realise the domain. Author them in this DAG, loading each
view's brief as you reach it:

```text
[reverse only: context-mapper] → language ─► domain ─┬─► architecture
                                                     └─► data
```

| View | Brief (skill `references/…`) | Output template (`assets/…`) | Persona for fan-out (root `agents/…`) |
| --- | --- | --- | --- |
| language | `language.md` | `ubiquitous-language.md` | `language-modeler.md` |
| domain | `domain.md` | `domain-model.md` | `domain-modeler.md` |
| architecture | `architecture.md` | `architecture.md` | `architecture-modeler.md` |
| data | `data.md` | `data-model.md` | `data-modeler.md` |
| (reverse discovery) | `reverse.md` | `assets/proposal/` | `context-mapper.md` |

**Default — run the views yourself, in one context.** Load each brief as you reach its view, author into the
template, and carry the upstream views' output forward in your own context. The views are cross-referential
(domain cites language ids; architecture and data cite domain ids), so holding them in one context is what
keeps them coherent. Run **only the view(s) the source actually touches** — a change that adds no new
language/domain/data skips that view. Collect each view's delta into the run's `design-delta.md`.

**Fan out to a dedicated subagent per view only when the work outgrows one context.** Give each modeler its
persona + its brief + the upstream views' output (language → everyone; domain → architecture & data), and
tell it to read both before authoring; the DAG order still holds. It pays when:

- the existing `_system/<ctx>/` is large enough that reading all four views' state crowds out the authoring, or
- the independent branches (architecture ∥ data) are each substantial and parallel wall-clock matters, or
- reverse runs over a large codebase — discovery + per-context distillation won't fit one window.

Below that threshold the trade loses: an isolated modeler re-reads context you already hold, and cross-view
coherence weakens. Fan-out is an optimization for scale — coherence is the default.

## Shared discipline (every view, every mode)

- **Lazy boundary / coherent within** — don't model an untouched context; on first touch model the touched
  aggregate's closure conceptually and materialise only what the current need requires. Falsifiable test:
  *"if I omit this, can a future spec re-introduce the same concept under a different name?"* Yes → model now.
- **Additive only** — ids are unique and stable within the context; a change is a new element + migration,
  never a renumber or rewrite.
- **Reference, never copy** — reference shared ids (`LANG/DOM/ARCH/DATA-<CTX>-NNN`) across views and from
  specs; never duplicate their content (duplication drifts). Diagrams are derived downstream; the data
  view has **one structured source that fits the actual persistence** — DBML for a relational DB, the
  code schema (e.g. the project's Zod/TS types) for a JSON/document store — never a second model that
  duplicates the live one. Skip the data view entirely when the change persists no new state.
- **Reverse = draft, with evidence** — distilled-from-code output is a proposal a human promotes, never a
  silent overwrite of authored truth. Tag every proposed element with its `file:symbol` evidence and
  separate what you observed from what you inferred.

> The full ideal (DOC_TAXONOMY 7 views) also has contracts (`CONTRACT-<CTX>-NNN`), cross-cutting NFR, ADR,
> and the `context-map.md` index. Those are not yet first-class here — author them when the dial calls for
> them; this skill owns the four views above (plus a reverse `context-map` note).

## Self-check, then stop

Record the run's `reads` / `extends` (with affected AC-IDs in spec mode) in a `design-delta.md` (template:
[assets/design-delta.md](assets/design-delta.md)), then run the deterministic check (the orchestrator
re-runs it authoritatively; skill-independent). Fix until it passes:

```bash
# spec-driven / top-down — delta written into the system layer (--system auto-discovers the nearest _system):
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-system-design.ts <run-dir> [--system <ctx-system-dir>]
# reverse — staged proposal (additive vs existing, reads resolve, no spec linkage):
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-system-design.ts <proposal-dir> --proposal --system <ctx-system-dir>
```

Signal completion — you do not change workflow state and do not sign. What follows is an independent review
of the extension against the whole bounded context (in reverse mode, the human reviewing and promoting the
staged proposal into `_system/`).

---

Per-view briefs live in `references/` (language / domain / architecture / data + reverse), output templates
in `assets/`, per-view personas in root `agents/`. Integrity invariants are owned by
`scripts/check-system-design.ts` (which vendors `src/design/lint.ts`), not by any prose doc.
