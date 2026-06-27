---
name: to-detail-design
description: 署名済み spec を PR サイズのスライスに分解する詳細設計（コンポーネント設計・スライス分解）。
when_to_use: 詳細設計・スライス分解・コンポーネント設計・PR 分割・issue 分解のとき。system 層（ドメイン/アーキ/データ）の設計は to-system-design を使う。
argument-hint: [spec-dir]
allowed-tools: Read, Write, Edit, Bash
arguments: spec_dir
---

# To detail design

Decompose a signed `spec.md` into PR-size slices that reference the system layer. You assist;
the check in `scripts/check-detail-design.ts` enforces the invariants. The human owns the WHAT — never
edit `spec.md` / `acceptance.yaml`.

## Input / output

| | |
| --- | --- |
| **In** | signed `spec.md` + `acceptance.yaml`; the system layer it touches (referenced, not copied) |
| **Out** | `slices/SLICE-<SPEC>-NNN.md` (one per slice) + an `IssueSpawnOrder` per slice |

Fill the template: [slice](assets/slice.md).

## Rules

- One spec per run; when you run is decided for you. You **reference** system elements
  (`dependsOnSystem`), never author them.
- **Coverage AND exclusivity, both ways**: the union of every slice's `coversAcIds` equals the spec's AC
  set, with no AC in two slices. An oversized AC goes back to authoring to be split — never split an AC
  across slices.
- **Seam / contract altitude only** — pin any algorithm you want to fix in non-gated `implementationNotes`.
- Detail, the ```yaml core format, and a worked example are in
  [references/detail-design.md](references/detail-design.md). Sequence diagrams are derived downstream,
  not authored here.

## Self-check, then stop

Run the same deterministic lint the orchestrator re-runs authoritatively (skill-independent); fix until
it passes, to catch coverage / id breaks before a reviewer sees them:

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-detail-design.ts <spec-dir>
```

Signal completion — you do not change workflow state and do not sign; an independent review follows.
