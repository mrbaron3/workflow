---
name: to-system-design
description: 承認済み spec.md から system 層の設計を境界コンテキスト単位で著す・拡張する。基本設計（アーキ）・DB設計（データモデル）・ドメインモデル・スキーマ設計・アーキテクチャ・境界コンテキストのときに使う。詳細設計（スライス分解）は to-slice-design を使う。
allowed-tools: Read, Write, Edit, Bash
---

# To system design

Author/extend the **global, single-source-of-truth system layer** for one bounded context, from an
already-signed `spec.md`. You assist; the checks in `scripts/check-system-design.ts` enforce the
structural invariants. The human owns the WHAT and has signed it — you never edit `spec.md` /
`acceptance.yaml`.

## Scope

**One bounded context**: `domain-map.md` (`DOM-NNN`) / `data-model.md` (`DATA-NNN`) / `architecture.md`
(`ARCH-NNN`). You are invoked for one context at a time; which context, and when, is decided for you.
The system layer is owned across features, not re-derived per feature. Slice decomposition is a separate
skill (`to-slice-design`) — you author system elements, slices only reference them.

## What to do

- Read the whole relevant context first — global consistency is the point.
- Extend **additively** only — never renumber or rewrite an existing element id.
- **Lazy boundary / coherent within**: model the touched aggregate's conceptual closure; materialise
  physical schema only for the current acceptance criteria. The rule, the falsifiable "model it now?"
  test, and a worked example are in `references/system-mode.md`.
- Contract altitude only; emit a machine-extractable structured core (so diagrams render
  deterministically).
- Record what the feature `reads` / `extends` (with the affected AC-IDs) in the epic's `design-delta.md`.

## Diagrams are derived, not authored here

ER / component / domain diagrams render from this layer downstream and are not gated. Emit the structured
core; do not hand-author diagrams.

## Self-check, then stop

```bash
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts <epic-dir>
```

Signal completion. You do not change workflow state and do not sign — an independent review of the
extension against the whole context follows.
