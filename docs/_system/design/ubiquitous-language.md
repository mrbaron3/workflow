# ユビキタス言語 — design コンテキスト

> design コンテキストは、署名 spec から **system 層（4ビュー）を設計**し、PR サイズの **Issue 集合へ分解**する
> ことを所有する。[context-map.md](../../context-map.md) の境界に従う。追加のみ（`LANG-design-NNN` は安定）。
>
> 注: 旧 GLOSSARY の `ArchitectureSpine`（Tier1）/`DesignSlice`（Tier2）/`IssueSpawnOrder` は M21 レガシーで、
> 新モデル（system 層 ＋ store の Issue）に **supersede 済み**——本コンテキストでは使わない。

| ID | 用語 | 意味（design コンテキスト内で一貫） |
| --- | --- | --- |
| LANG-design-001 | 境界コンテキスト | system 層の組織単位。1つのユビキタス言語が一貫する範囲（[context-map.md](../../context-map.md)）。 |
| LANG-design-002 | system 層 | 境界ごとの4ビュー（言語/ドメイン/アーキ/データ）＝ additive な単一正本。`_system/<ctx>/` に住む。 |
| LANG-design-003 | system 要素 | `LANG/DOM/ARCH/DATA-<CTX>-NNN`。ビュー横断・spec から id で**参照**され、複製されない。 |
| LANG-design-004 | seam | 他ユニットが噛み合う public な署名/契約。アーキビューが持つ（内部実装は持たない）。 |
| LANG-design-005 | 構造化 SSOT ＋ 派生スキン | 各ビューの核は構造化ソース（永続実体に合わせる: RDB→DBML / JSON→コードスキーマ）、図は派生。 |
| LANG-design-006 | design-delta | 1 回の設計 run が読む（reads）/足す（extends）system 要素の記録。spec モードでは affectedAcIds を持つ。 |
| LANG-design-007 | Issue（詳細設計の分解単位） | 署名 spec を分解した **1 PR サイズ**の単位。store の Issue として実体化（markdown slice は持たない）。 |
| LANG-design-008 | 被覆×排他 | spec の全 AC が、issue 集合でちょうど 1 回ずつ覆われる（落とさず・重複させず）双方向一致。コードが強制。 |
| LANG-design-009 | coversAcIds | ある Issue が負う署名 AC-ID 集合。被覆×排他の単位。 |
| LANG-design-010 | dependsOnSystem | Issue が参照する system 要素 id（`DOM/DATA/ARCH/…-<CTX>-NNN`）。参照のみ・複製しない。 |
