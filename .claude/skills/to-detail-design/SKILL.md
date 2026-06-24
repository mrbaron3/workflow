---
name: to-detail-design
description: 詳細設計（コンポーネント設計・スライス分解）を epic 単位で行う。詳細設計・スライス分解・コンポーネント設計・PR 分割・issue 分解のときに使う。基本設計（ドメイン/アーキ）は to-basic-design、DB設計は to-db-design を使う。
allowed-tools: Read, Write, Edit, Bash
arguments: epic_dir
context: fork
hooks:
  Stop:
    - hooks:
        - type: command
          command: '[ -d "$1" ] && npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-detail-design.ts "$1" || exit 0'
---

# To detail design

Decompose one epic's signed `spec.md` into PR-size slices that reference the system layer. You assist;
the check in `scripts/check-detail-design.ts` enforces the invariants. The human owns the WHAT — never
edit `spec.md` / `acceptance.yaml`.

## Input / output

| | |
| --- | --- |
| **In** | signed `spec.md` + `acceptance.yaml`; the system layer it touches (referenced, not copied) |
| **Out** | `slices/SLICE-<EPIC>-NNN.md` (one per slice) + an `IssueSpawnOrder` per slice |

Fill the template: [slice](assets/slice.md).

## Rules

- One epic per run; when you run is decided for you. You **reference** system elements
  (`dependsOnSystem`), never author them.
- **Coverage AND exclusivity, both ways**: the union of every slice's `coversAcIds` equals the spec's AC
  set, with no AC in two slices. An oversized AC goes back to authoring to be split — never split an AC
  across slices.
- **Seam / contract altitude only** — pin any algorithm you want to fix in non-gated `implementationNotes`.
- Detail, the ```yaml core format, and a worked example are in
  [references/detail-design.md](references/detail-design.md). Sequence diagrams are derived downstream,
  not authored here.

## Self-check, then stop

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-detail-design.ts <epic_dir>
```

The Stop hook re-runs this and blocks completion on failure. Signal completion — you do not change
workflow state and do not sign; an independent review follows.
