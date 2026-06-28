---
name: to-system-design
description: 設計層の system 層（ユビキタス言語・ドメインモデル・アーキテクチャ・データモデル）を境界コンテキスト単位で著す・拡張する。
when_to_use: 基本設計・方式設計・アーキテクチャ・ドメインモデル・ユビキタス言語・モジュール境界・seam・DB設計・データモデル・スキーマ設計・正規化・マイグレーションを作るとき。署名済み spec を Issue/PR に分解するのは to-detail-design を使う。
argument-hint: [spec-dir]
allowed-tools: Read, Write, Edit, Bash
arguments: spec_dir
---

# To system design

Author/extend the **global, single-source-of-truth system layer** — language, domain, architecture, and
data — for the bounded context(s) a signed `spec.md` touches. You assist;
`scripts/check-system-design.ts` enforces the structural invariants. The human owns the WHAT — never edit
`spec.md` / `acceptance.yaml`, never sign.

This layer is **coarser than a spec**: a bounded context is designed and owned across specs, not
re-derived each time. It lives under `_system/<context>/` and each view has its own additive id space
(never renumber/rewrite). Read the whole relevant context and add to it.

## Two perspectives, one order — data follows domain

1. **Domain** → `ubiquitous-language.md` (`LANG-<CTX>-NNN`) → `domain-model.md` (`DOM-<CTX>-NNN`) →
   `architecture.md` (`ARCH-<CTX>-NNN`): the words first, then the entities/aggregates/invariants in
   those words, then the module boundaries and seams built on them. Brief + worked example:
   [references/domain.md](references/domain.md).
2. **Data** → `data-model.md` (`DATA-<CTX>-NNN`): the logical model that *realises* the domain entities
   (it never invents new concepts). The **DBML block is the structured SSOT**; the Mermaid `erDiagram` is
   derived from it. Brief + worked example: [references/data.md](references/data.md).

Run the domain perspective first; data builds on the boundaries it fixes. Run only the perspective(s) and
view(s) the spec actually touches — a spec that adds no new language/domain/data skips that step.

> The full ideal (DOC_TAXONOMY 7 views) also has contracts (`CONTRACT-<CTX>-NNN`), cross-cutting NFR, ADR,
> and the `context-map.md` index. Those are not yet first-class here — author them when the dial calls for
> them; this skill owns the four views above.

## Shared discipline (both perspectives)

- **Lazy boundary / coherent within** — don't model an untouched context; on first touch, model the
  touched aggregate's closure conceptually, and materialise only what the current AC needs.
- **Additive only** — ids are unique and stable within the context; a change is a new element + migration,
  never a renumber or rewrite.
- **Contract altitude** — public shape only; internal algorithms/representations are the implementer's.
  Reference shared ids (`LANG/DOM/ARCH/DATA-<CTX>-NNN`), never copy their content. Diagrams are derived
  downstream, not authored here (the data view's DBML is the one structured source you do author).

## Self-check, then stop

Record `reads` / `extends` (with affected AC-IDs) in the spec's `design-delta.md`, then run the same
deterministic lint the orchestrator re-runs authoritatively (skill-independent); fix until it passes:

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-system-design.ts <spec-dir>
```

Signal completion — you do not change workflow state and do not sign; an independent review of the
extension against the whole bounded context follows.

---

Per-perspective briefs live in `references/`, output templates in `assets/` (ubiquitous-language /
domain-model / architecture / data-model). Integrity invariants are owned by
`scripts/check-system-design.ts` (which vendors `src/design/lint.ts`), not by any prose doc.
