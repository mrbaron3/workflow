---
name: to-db-design
description: DB設計（データモデル・スキーマ・永続化契約）を境界コンテキスト単位で著す・拡張する。DB設計・データモデル・スキーマ設計・テーブル設計・正規化・マイグレーションのときに使う。基本設計（ドメイン/アーキ）は to-basic-design、詳細設計（スライス）は to-detail-design を使う。
allowed-tools: Read, Write, Edit, Bash
arguments: epic_dir
context: fork
hooks:
  Stop:
    - hooks:
        - type: command
          command: '[ -d "$1" ] && npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-db-design.ts "$1" || exit 0'
---

# To db design

Author/extend the **global, single-source-of-truth** data model for one bounded context, from a signed
`spec.md`. You assist; the check in `scripts/check-db-design.ts` enforces the structural invariants. The
human owns the WHAT — never edit `spec.md` / `acceptance.yaml`.

## Input / output

| | |
| --- | --- |
| **In** | signed `spec.md` + `acceptance.yaml`; the domain model for this context + the existing data model (read whole) |
| **Out** | additive elements in `_system/<context>/data-model.md` (`DATA-NNN`); the epic's `design-delta.md` (`reads` / `extends`) |

Fill the template: [data-model](assets/data-model.md).

## Rules

- One bounded context per run; which context, and when, is decided for you. Data follows the domain — read
  the domain model first.
- **Additive only** — element ids are stable; change = a new element + migration, never a rewrite.
- **Lazy boundary / coherent within**: model the aggregate conceptually, materialise physical columns only
  for the current acceptance criteria. Detail and a worked example are in
  [references/db-design.md](references/db-design.md).
- Emit a machine-extractable structured core. ER diagrams are derived downstream, not authored here.

## Self-check, then stop

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-db-design.ts <epic_dir>
```

The Stop hook re-runs this and blocks completion on failure. Signal completion — you do not change
workflow state and do not sign; an independent review of the extension against the whole context follows.
