---
name: to-slice-design
description: 承認済み spec.md と system 層から、epic を PR サイズのスライス（詳細設計・コンポーネント設計）へ分解する。詳細設計・スライス分解・コンポーネント設計・PR 分割・issue 分解のときに使う。基本設計/DB設計（system 層）は to-system-design を使う。
allowed-tools: Read, Write, Edit, Bash
---

# To slice design

Decompose one epic's signed `spec.md` into PR-size slices that reference the system layer. You assist;
the checks in `scripts/check-slice-design.ts` enforce the invariants. The human owns the WHAT and has
signed it — you never edit `spec.md` / `acceptance.yaml`.

## Scope

**One epic.** Slices are per-epic / per-PR. You are invoked for one epic at a time; when you run is
decided for you. System-layer authoring (domain / data / architecture) is a separate skill
(`to-system-design`) — here you **reference** system elements, never author them.

## What to do

- Decompose the epic's AC into PR-size slices. **Coverage AND exclusivity, both ways**: the union of
  every slice's `coversAcIds` equals the spec's AC set, with no AC in two slices. An AC is the smallest
  unit — an oversized AC goes back to authoring to be split, never split across slices.
- Each slice file carries one ```yaml structured core (`sliceId` / `coversAcIds` / `dependsOnSlices` /
  `dependsOnSystem`). Format + worked example: `references/slice-mode.md`.
- Reference system elements by id (`dependsOnSystem`); never copy them. **Seam / contract altitude
  only** — pin any algorithm you want to fix in non-gated `implementationNotes`.
- Emit an `IssueSpawnOrder` (version-pinned references only) per slice — the handoff and the completion
  signal.

## Diagrams are derived, not authored here

Sequence diagrams render from your `componentDesign` seams + `architecture.md` and are not gated. If a
needed interaction is not derivable, that is a missing seam — fix the design, not the diagram.

## Self-check, then stop

```bash
npx tsx .claude/skills/to-slice-design/scripts/check-slice-design.ts <epic-dir>
```

Signal completion. You do not change workflow state and do not sign — an independent review follows.
