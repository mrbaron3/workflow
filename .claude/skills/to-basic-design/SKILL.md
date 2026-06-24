---
name: to-basic-design
description: 基本設計（ドメインモデルとアーキテクチャ）を境界コンテキスト単位で著す・拡張する。基本設計・方式設計・アーキテクチャ・ドメインモデル・モジュール境界・seam を作るときに使う。DB設計は to-db-design、詳細設計（スライス）は to-detail-design を使う。
allowed-tools: Read, Write, Edit, Bash
arguments: epic_dir
context: fork
hooks:
  Stop:
    - hooks:
        - type: command
          command: '[ -d "$1" ] && npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-basic-design.ts "$1" || exit 0'
---

# To basic design

Author/extend the **global, single-source-of-truth** domain model and architecture for one bounded
context, from a signed `spec.md`. You assist; the check in `scripts/check-basic-design.ts` enforces the
structural invariants. The human owns the WHAT — never edit `spec.md` / `acceptance.yaml`.

## Input / output

| | |
| --- | --- |
| **In** | signed `spec.md` + `acceptance.yaml`; the existing system layer for this context (read it whole) |
| **Out** | additive elements in `_system/<context>/domain-map.md` (`DOM-NNN`) + `architecture.md` (`ARCH-NNN`); the epic's `design-delta.md` (`reads` / `extends`) |

Fill the templates: [domain-map](assets/domain-map.md), [architecture](assets/architecture.md).

## Rules

- One bounded context per run; which context, and when, is decided for you.
- **Additive only** — element ids are stable; never renumber or rewrite.
- **Lazy boundary / coherent within** + contract altitude. Detail and a worked example are in
  [references/basic-design.md](references/basic-design.md).
- Emit a machine-extractable structured core. Diagrams are derived downstream, not authored here.

## Self-check, then stop

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-basic-design.ts <epic_dir>
```

The Stop hook re-runs this and blocks completion on failure. Signal completion — you do not change
workflow state and do not sign; an independent review of the extension against the whole context follows.
