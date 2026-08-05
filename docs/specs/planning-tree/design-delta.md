# Design delta — planning-tree (planning context, greenfield)

- mode: spec-driven
- context(s): planning
- summary: 署名済み planning-tree spec から `planning` 境界コンテキストの 4 ビューを seed。spec の前方参照
  （AC-PLAN-008）を解消する——計画の木のスキーマ（Roadmap/Epic/Feature/SpecState/ApprovedSpecRef・id・
  リンク・取込/spawn seam）が、spec ではなく system 層に住む。データビューの構造化 SSOT は Zod schema
  （`apps/agentops/src/domain/schema.ts`）を参照し、テーブル（DBML）へ二重化しない。

```yaml
# Greenfield: this is the first bounded context, so nothing pre-exists to read.
reads: []
# extends: every id this run ADDS (additive only). Spans all four views of _system/planning/.
extends:
  # view 1 — ubiquitous language
  - elementId: LANG-planning-001
  - elementId: LANG-planning-002
  - elementId: LANG-planning-003
  - elementId: LANG-planning-004
  - elementId: LANG-planning-005
  - elementId: LANG-planning-006
  - elementId: LANG-planning-007
  - elementId: LANG-planning-008
  - elementId: LANG-planning-009
  - elementId: LANG-planning-010
  - elementId: LANG-planning-011
  - elementId: LANG-planning-012
  - elementId: LANG-planning-013
  - elementId: LANG-planning-014
  # view 2 — domain model
  - elementId: DOM-planning-001
    affectedAcIds: [AC-PLAN-001]
  - elementId: DOM-planning-002
    affectedAcIds: [AC-PLAN-001]
  - elementId: DOM-planning-003
    affectedAcIds: [AC-PLAN-001, AC-PLAN-008]
  - elementId: DOM-planning-004
    affectedAcIds: [AC-PLAN-003, AC-PLAN-008]
  - elementId: DOM-planning-005
    affectedAcIds: [AC-PLAN-007, AC-PLAN-008]
  - elementId: DOM-planning-006
    affectedAcIds: [AC-PLAN-001, AC-PLAN-006]
  - elementId: DOM-planning-007
    affectedAcIds: [AC-PLAN-003, AC-PLAN-004]
  - elementId: DOM-planning-008
    affectedAcIds: [AC-PLAN-002]
  - elementId: DOM-planning-009
    affectedAcIds: [AC-PLAN-005, AC-PLAN-007]
  - elementId: DOM-planning-010
    affectedAcIds: [AC-PLAN-009]
  - elementId: DOM-planning-011
    affectedAcIds: [AC-PLAN-003]
  - elementId: DOM-planning-012
    affectedAcIds: [AC-PLAN-008]
  # view 3 — architecture
  - elementId: ARCH-planning-001
    affectedAcIds: [AC-PLAN-001, AC-PLAN-002]
  - elementId: ARCH-planning-002
    affectedAcIds: [AC-PLAN-001, AC-PLAN-006]
  - elementId: ARCH-planning-003
    affectedAcIds: [AC-PLAN-003, AC-PLAN-005]
  - elementId: ARCH-planning-004
    affectedAcIds: [AC-PLAN-001, AC-PLAN-007]
  - elementId: ARCH-planning-005
    affectedAcIds: [AC-PLAN-007, AC-PLAN-008]
  - elementId: ARCH-planning-006
    affectedAcIds: [AC-PLAN-008]
  - elementId: ARCH-planning-007
  - elementId: ARCH-planning-008
    affectedAcIds: [AC-PLAN-001]
  - elementId: ARCH-planning-009
    affectedAcIds: [AC-PLAN-005]
  # view 4 — data model (resolves the spec's forward reference, AC-PLAN-008)
  - elementId: DATA-planning-001
    affectedAcIds: [AC-PLAN-001]
  - elementId: DATA-planning-002
    affectedAcIds: [AC-PLAN-001]
  - elementId: DATA-planning-003
    affectedAcIds: [AC-PLAN-001, AC-PLAN-008]
  - elementId: DATA-planning-004
    affectedAcIds: [AC-PLAN-002]
  - elementId: DATA-planning-005
    affectedAcIds: [AC-PLAN-003]
  - elementId: DATA-planning-006
    affectedAcIds: [AC-PLAN-009]
  - elementId: DATA-planning-007
    affectedAcIds: [AC-PLAN-003, AC-PLAN-008]
  - elementId: DATA-planning-008
    affectedAcIds: [AC-PLAN-007, AC-PLAN-008]
  - elementId: DATA-planning-009
    affectedAcIds: [AC-PLAN-001]
  - elementId: DATA-planning-010
    affectedAcIds: [AC-PLAN-003, AC-PLAN-008]
  - elementId: DATA-planning-011
    affectedAcIds: [AC-PLAN-005, AC-PLAN-007, AC-PLAN-009]
```

## メモ（人間可読）

- **すべて additive（greenfield）。** `planning` は最初の境界コンテキスト; 既存 id を renumber・書き換えしない。
  配置は `docs/specs/_system/planning/`——3 つの決定論 check が一致する場所（`check-system-design` は上方向に
  辿って到達; `check-detail-design` と `spawnIssues` は `<spec-dir>/../_system` を既定参照）。
- **何を解消するか。** spec は計画の木の*スキーマ*を意図的に system 層へ委ねた（レッドラインが Feature/Epic/Spec
  型の `spec.md` 埋め込みを禁じる）。`data-model.md` がそのスキーマを
  **Zod schema（`apps/agentops/src/domain/schema.ts`）参照**
  として持ち、spec の前方参照（AC-PLAN-008）を閉じる。
- **lazy boundary。** execution コンテキスト（署名 spec → Issue → PR → EvalRun）は境界として参照するだけで、ここでは
  設計しない: `Issue` スキーマは planning コンテキストの外。planning の AC が要する分だけ設計し、下流は AC が要求する
  まで遅延する。
- **永続実体に忠実。** 永続は JSON ストアで、データの正本は既に
  `apps/agentops/src/domain/schema.ts`（Zod）。データビューは
  それを**参照**し、テーブルとして再モデル化しない（二重 SSOT を作らない＝ハーネスが自分自身を設計する）。
