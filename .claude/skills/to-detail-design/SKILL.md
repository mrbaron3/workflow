---
name: to-detail-design
description: 署名済み spec を PR サイズの Issue 集合に分解する詳細設計（コンポーネント設計・Issue 分解）。
when_to_use: 詳細設計・Issue 分解・スライス分解・コンポーネント設計・PR 分割のとき。system 層（ドメイン/アーキ/データ）の設計は to-system-design を使う。
argument-hint: [spec-dir]
allowed-tools: Read, Write, Edit, Bash
arguments: spec_dir
---

# To detail design

Decompose a signed `requirements.md` (legacy: `spec.md`) into a set of PR-size **Issues** that reference the system layer. You
assist; the check in `scripts/check-detail-design.ts` enforces the invariants. The human owns the
WHAT — never edit `requirements.md` (legacy `spec.md`) / `acceptance.yaml`.

## Input / output

| | |
| --- | --- |
| **In** | signed `requirements.md` (legacy: `spec.md`) + `acceptance.yaml`; the system layer it touches (referenced, not copied) |
| **Out** | `issues.yaml` — the spawn manifest: one PR-size Issue per entry |

`issues.yaml` is a *spawn manifest*, not an authored document: a deterministic ingest allocates each
store `ISSUE-NNNN` id, links it to the feature/spec, and lands it in the store — nano state lives there,
so there are no markdown slice docs. Fill the template: [issues.yaml](assets/issues.yaml).

## Rules

- One spec per run; when you run is decided for you. You **reference** system elements
  (`dependsOnSystem`), never author them.
- **Coverage AND exclusivity, both ways**: the union of every issue's `coversAcIds` equals the spec's
  AC set, with no AC in two issues. An oversized AC goes back to authoring to be split — never split an
  AC across issues.
- **One Issue = one PR**: size each entry so a single agent can land it as one reviewable PR.
- **Seam / contract altitude only** — put the seams another unit meshes with (and any algorithm you
  want to pin) in non-gated `implementationNotes`, not class internals.
- `key` is a draft-local handle (the store `ISSUE-NNNN` id is allocated at spawn); keep it stable and
  unique within the set. The manifest format, ids, and a worked example are in
  [references/detail-design.md](references/detail-design.md). Sequence diagrams are derived
  downstream, not authored here.

## Self-check, then stop

Run the same deterministic lint the orchestrator re-runs authoritatively (skill-independent); fix until
it passes, to catch coverage / key / ref breaks before a reviewer sees them:

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-detail-design.ts <spec-dir>
```

Signal completion — you emit the manifest and do not change workflow state or sign; an independent
review and the deterministic spawn follow.
