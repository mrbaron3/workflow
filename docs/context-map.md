# コンテキストマップ（macro 索引・keystone）

> system の木の入口。全**境界コンテキスト**の一覧と、その**関係**を DDD の関係パターンで1枚にする
> （DOC_TAXONOMY §索引）。「どの境界がどの言語で話し、どこで翻訳されるか」を示す。各コンテキストの内実は
> `_system/<ctx>/` に住む。語はコンテキストで意味が変わるので、グローバル1冊の用語集は持たない
> （per-context の `ubiquitous-language.md` ＋ ここでの翻訳点）。

- 種別: system（macro 索引）
- 状態: ドラフト（planning のみ system 層実体化済み・他は移行待ち）

## 境界コンテキスト一覧

ハーネスを「1つのユビキタス言語が一貫する範囲」で切ると4つ。技術レイヤー（Product/Execution/…）ではなく
**言語の境界**で分ける。

| コンテキスト | 責務（一文） | 主なコード | system 層 | 代表用語 |
| --- | --- | --- | --- | --- |
| **planning** | 製品ゴールを roadmap→epic→feature に分解し永続、各 feature を spec へ materialize | `src/planning/` | `_system/planning/` ✅ | Roadmap・Epic・Feature・Outcome・取込・spawn |
| **authoring** | 人間が spec の WHAT（AC）を著述し**署名**、署名後のドリフトを検知 | `src/authoring/` | `_system/authoring/`（未） | Spec・acceptance.yaml・ApprovedSpecRef・署名・fingerprint・ドリフト |
| **design** | 署名 spec から system 層（4ビュー）を設計し、PR サイズの Issue 集合へ分解 | `src/design/`・`planning-tree.ts:spawnIssues` | `_system/design/`（未） | 境界コンテキスト・ドメインモデル・seam・被覆×排他・dependsOnSystem |
| **evaluation** | Issue Contract を生成→評価→修正→リリースし、証拠から指標・回帰・改善を育てる | `src/pipeline/`・`graders/`・`metrics/`・`agents/`・`resolve/` | `_system/evaluation/`（未） | Issue Contract・Generator・PR・Scorecard・EvalRun・pass@k・Repair・Curator・Analyst |

**共有カーネル（Shared Kernel）**: `src/domain/`（`schema.ts` の zod 契約 ＋ `states.ts` の状態機械）と
`src/store/`（Eval Result DB）は4コンテキストすべてが共有する。これがコンテキスト間の **Published Language**
＝各コンテキストは生の内部表現でなく zod 契約で会話する。`cli/`・`dashboard/`・`config.ts`・`util/` は
プレゼンテーション/インフラでドメイン境界ではない。

## 関係（DDD 関係パターン）

```text
            ┌─────────────────────── 改善フィードバック（評価→計画）────────────────────────┐
            ▼                                                                              │
   ┌────────────┐  spec stub   ┌────────────┐  署名 spec   ┌──────────┐  issues+契約  ┌────────────┐
   │  planning  │ ───────────▶ │ authoring  │ ───────────▶ │  design  │ ───────────▶ │ evaluation │
   └────────────┘  C/S         └────────────┘  C/S・順応    └──────────┘  C/S          └────────────┘
            │                          │                        │                          │
            └──────────────────────────┴── Shared Kernel: domain（zod 契約・状態機械）＋ store ──┴───────┘
```

- **planning → authoring**（Customer-Supplier）: planning が feature ごとに**著述 stub spec** を供給し、authoring が AC を著述・署名する。
- **authoring → design**（Customer-Supplier・Conformist）: design は**署名された AC 集合に順応**する——issue の被覆は署名 AC とちょうど一致せねばならない（勝手に AC を足さない）。
- **design → evaluation**（Customer-Supplier）: design が Issue（被覆・seam 参照）を供給、evaluation が契約ドラフト→生成→評価→リリースで消費する。橋は `contract-draft`（署名 spec の AC を契約へ・新規著述しない）。
- **evaluation → planning**（改善フィードバック・Customer-Supplier）: Harness Analyst が `type:harness`/`type:eval` の改善 issue を計画の木へ戻し、Curator が失敗を回帰として育てる。北極星の「改善」軸の閉路。
- **Shared Kernel**: 4コンテキストは `domain`（契約・状態機械）と `store`（Eval DB）を共有する。契約が Published Language として境界を跨ぐ唯一の語彙。

## GLOSSARY.md / ARCHITECTURE.md 移行マップ

旧モノリシック2文書は理想ツリーに居場所が無い（DOC_TAXONOMY §理想ツリー）。中身を以下へ分解し、分解後に retire する。

### `docs/GLOSSARY.md` → per-context 言語 ＋ ここ

| 旧 GLOSSARY 用語 | 移行先 |
| --- | --- |
| Roadmap・Theme/Initiative・Epic・Feature・計画の木・planRoadmap/spawnSpecs | `_system/planning/ubiquitous-language.md` ✅（移行済） |
| Spec・spec.md・acceptance.yaml・ApprovedSpecRef・contract-approved・manual-requirements | `_system/authoring/ubiquitous-language.md`（未） |
| 被覆×排他・seam・DesignSlice・ArchitectureSpine（※レガシー語は整理）・IssueSpawnOrder | `_system/design/ubiquitous-language.md`（未・陳腐化語は捨てる） |
| Issue Contract・Agent Work Unit/sample・PR・Eval Run・Scorecard・Repair Loop・Eval Task Registry・Grader・Evidence・pass@k/pass^k・False pass/fail・Harness improvement・build-approved | `_system/evaluation/ubiquitous-language.md`（未） |
| Agile Sprint（時間箱）等の横断・翻訳点 | このコンテキストマップ（翻訳点として明記） |

### `docs/ARCHITECTURE.md` → context-map ＋ per-context architecture ＋ ADR

| 旧 ARCHITECTURE セクション | 移行先 |
| --- | --- |
| Layers（Product/Planning/Execution/Evaluation/Learning）= 技術レイヤーの俯瞰 | このコンテキストマップ（C4 文脈＝コンテキスト関係に再表現） |
| Data flow（one issue）= 評価ループの流れ | `_system/evaluation/architecture.md`（未・シーケンスは派生） |
| Extension seams（runner/store/grader/persona/metric の拡張点） | 各コンテキストの `architecture.md` の seam（`ARCH-<ctx>-NNN`）へ分配 |
| Key design choices（zod 契約・hard gates・決定論・pluggable backend） | 設計**判断**＝ `docs/decisions/`（ADR・未新設）／一部は Shared Kernel の不変条件としてここ |
| Why JSON, not SQLite | `docs/decisions/`（ADR・未新設） |

## 未 first-class（理想ツリーで前方参照済み）

- `_system/{authoring,design,evaluation}/` の4ビュー（言語/ドメイン/アーキ/データ）
- `docs/decisions/`（ADR・append-only・supersede 可）— ARCHITECTURE の設計判断の住処
- `docs/cross-cutting/`（NFR 横断）・`_system/<ctx>/contracts/`（CONTRACT・公開言語）
- `docs/_derived/`（feature-catalog・traceability・図一式）
