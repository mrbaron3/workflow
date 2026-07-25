# コンテキストマップ（macro 索引・keystone）

> system の木の入口。全**境界コンテキスト**の一覧と、その**関係**を DDD の関係パターンで1枚にする
> （DOC_TAXONOMY §索引）。「どの境界がどの言語で話し、どこで翻訳されるか」を示す。各コンテキストの内実は
> `_system/<ctx>/` に住む。語はコンテキストで意味が変わるので、グローバル1冊の用語集は持たない
> （per-context の `ubiquitous-language.md` ＋ ここでの翻訳点）。

- 種別: system（macro 索引）
- 状態: ドラフト（planning・execution・workspace・agent-runtime・intake・container-runtime は4ビュー実体化済み・他は移行待ち）

## 境界コンテキスト一覧

ハーネスを「1つのユビキタス言語が一貫する範囲」で切ると10。技術レイヤー（Product/…）ではなく
**言語の境界**で分ける。**execution は旧 ARCHITECTURE の技術層「Execution」ではない**——orchestration /
session / panel / sentinel という固有のユビキタス言語を持つ境界として立てる（[ADR-0005](decisions/ADR-0005-execution-layer-tmux-orchestration.md)）。
evaluation の採点語（Scorecard・Verdict）は所有せず参照する。

| コンテキスト | 責務（一文） | 主なコード | system 層 | 代表用語 |
| --- | --- | --- | --- | --- |
| **workspace** | 1つの組織storeを1つのtarget repositoryへ耐久的に束縛し、異targetへの状態変更を拒否 | `src/workspace/`・`src/store/`・`src/config.ts` | `_system/workspace/` ✅ | Workspace・Target Identity・Target Binding・Binding Mismatch |
| **planning** | 製品ゴールを roadmap→epic→feature に分解し永続、各 feature を spec へ materialize | `src/planning/` | `_system/planning/` ✅ | Roadmap・Epic・Feature・Outcome・取込・spawn |
| **authoring** | 人間が spec の WHAT（AC）を著述し**署名**、署名後のドリフトを検知 | `src/authoring/` | `_system/authoring/`（未） | Spec・acceptance.yaml・ApprovedSpecRef・署名・fingerprint・ドリフト |
| **design** | 署名 spec から system 層（4ビュー）を設計し、PR サイズの Issue 集合へ分解 | `src/design/`・`planning-tree.ts:spawnIssues` | `_system/design/`（未） | 境界コンテキスト・ドメインモデル・seam・被覆×排他・dependsOnSystem |
| **evaluation** | Issue Contract を生成→評価→修正→リリースし、証拠から指標・回帰・改善を育てる | `src/pipeline/`・`graders/`・`metrics/`・`agents/`・`resolve/` | `_system/evaluation/`（言語・アーキのみ） | Issue Contract・Generator・PR・Scorecard・EvalRun・pass@k・Repair・Curator・Analyst |
| **execution** | issue queue を入力に、issue ごとの実装を role-scoped tmux セッションのオーケストレーションで自律に進める独立層 | `src/pipeline/execution/`・`src/agents/` | `_system/execution/` ✅ | 実装層・Issue Queue・Orchestrator・Watch・Session・Sentinel・Evaluator Panel・観点・審査ゲート・Scoping Guard |
| **agent-runtime** | planning/UI-design/generation/reviewのAI呼出しを共通identityで監査し、provider/model固有差をadapterとrouteへ閉じる | `src/agents/`・`src/pipeline/execution/` | `_system/agent-runtime/` ✅ | Agent Invocation・Provider・Model・Role・Perspective Route・Provider Adapter |
| **intake** | target GitHub Issueをclaimし、planningと条件付きUI著述をtrace/provenance gate経由でIssueへ投影する | `src/intake/` | `_system/intake/` ✅ | Source Issue・Acceptance Trace・UI Design Artifact・Claim・Enrichment |
| **webhook** | GitHub deliveryをdurable inboxへ受け、複数repoをtransport非依存eventとしてconsumerへrouteし、pollで照合する | `src/webhook/` | `_system/webhook/` ✅ | Delivery Envelope・Durable Inbox・Repository Registration・Normalized Event・Reconciliation |
| **container-runtime** | 標準OCIアプリイメージをbuildし、Apple Container等の**コンテナ**runtime操作をadapter境界へ隔離、network/volume/port/capabilityを起動前にfail-closed検査する（AC-CISO-011） | `src/runtime/`・`deploy/Containerfile` | `_system/container-runtime/` ✅ | Container Runtime Adapter・Standard OCI Image・Runtime Preflight・Publish Invariant・Container-Neutral Path |

**共有カーネル（Shared Kernel）**: `src/domain/`（`schema.ts` の zod 契約 ＋ `states.ts` の状態機械）と
`src/store/`（Eval Result DB）は各状態コンテキストが共有する。これがコンテキスト間の **Published Language**
＝各コンテキストは生の内部表現でなく zod 契約で会話する。`cli/`・`dashboard/`・`config.ts`・`util/` は
プレゼンテーション/インフラでドメイン境界ではない。

## 関係（DDD 関係パターン）

```text
                 ┌──────────────── workspace: store ↔ target binding ────────────────┐
                 ▼                                                                    ▼
       ┌──────────────────── 改善フィードバック（評価→計画）──────────────────────────────┐
       ▼                                                                                 │
 ┌──────────┐ spec stub ┌──────────┐ 署名spec ┌────────┐ issues  ┌───────────┐  駆動  ┌────────────┐
 │ planning │ ────────▶ │authoring │ ───────▶ │ design │ ═══════▶│ execution │ ─────▶ │ evaluation │
 └──────────┘   C/S     └──────────┘ C/S順応  └────────┘ queue   └───────────┘  SK    └────────────┘
       │                     │                   │       =ACL         │                     │
       └─────────────────────┴──── Shared Kernel: domain（zod 契約・状態機械）＋ store ───────┴─────────┘
```

> `design ═▶ execution` の二重線は**層境界（ACL）**＝issue queue。execution は queue を poll して消費し、
> evaluation の役割（Generator/Evaluator）を tmux セッションとして**駆動**する（Shared Kernel）。

- **planning → authoring**（Customer-Supplier）: planning が feature ごとに**著述 stub spec** を供給し、authoring が AC を著述・署名する。
- **workspace → 全状態変更コンテキスト**（Shared Kernel guard）: workspace がstoreとtargetの対応を検証してから
  target rootを供給する。各コンテキストはconfig pathを独自解釈せず、Binding Mismatchでは書込み前に停止する。
- **authoring → design**（Customer-Supplier・Conformist）: design は**署名された AC 集合に順応**する——issue の被覆は署名 AC とちょうど一致せねばならない（勝手に AC を足さない）。
- **design → execution**（Customer-Supplier・issue queue が ACL）: design が署名 spec を Issue（被覆・seam 参照）へ分解し供給、execution が **contract-drafted かつ ai-managed** な issue を queue から poll して消費する。橋は `contract-draft`（署名 spec の AC を契約へ・新規著述しない）。実装層は「issue がどう作られたか」に依存しない（`_system/execution/`・ADR-0005）。
- **execution ↔ evaluation**（Shared Kernel・execution が駆動）: execution は evaluation の Generator/Evaluator/grader を **role-scoped tmux セッション**として起動・fan-in し、観点パネルで採点を束ねる。採点の意味論（hard-gate→score・Scorecard・Verdict）は evaluation が所有し、execution は再定義せず参照する。
- **execution → agent-runtime**（Customer-Supplier）: executionはrole/perspective/cwd/evidence契約を供給し、
  agent-runtimeがprovider固有起動へ翻訳してInvocation Provenanceをstoreへ投影する。executionはClaude/Codexの
  command形を知らず、agent-runtimeはqueue・panel verdictを決めない。
- **GitHub → intake → planning**（ACL・Customer-Supplier）: intakeはreadyなGitHub Issueを外部投影としてclaimし、
  immutable原文snapshotをplanningへ供給する。planningがIssue Contract-readyへ昇格するまでexecution queueへ入れない。
- **GitHub → webhook → intake/execution**（ACL・Published Language）: webhookはdeliveryを保存・重複排除し、
  Normalized GitHub Eventだけをintake/PR revision loopへ渡す。payloadはtriggerであり真実ではないため、
  consumerはcurrent snapshotを再取得する。pollは同じseamへreconciliation eventを供給する。
- **planning → intake UI authoring → execution**（Customer-Supplier・ACL）: frontend/fullstack Candidateだけを専用
  ui-designer sessionへ渡し、AC-traceableなUI Design Artifactを検証する。不在・曖昧・不正はqueueへ投影せず、
  accepted artifactはIssueのPublished Languageとしてgeneratorと各reviewerへ渡す。
- **evaluation → planning**（改善フィードバック・Customer-Supplier）: Harness Analyst が `type:harness`/`type:eval` の改善 issue を計画の木へ戻し、Curator が失敗を回帰として育てる。北極星の「改善」軸の閉路。
- **全稼働コンテキスト → container-runtime**（Customer-Supplier・OS非依存port）: 稼働コンテキストは role／topology／container-neutral path 契約を供給し、container-runtime が標準 OCI イメージと Apple Container 等の runtime 操作へ翻訳する。core は Provider CLI 形や macOS 詳細を知らず、Apple Container 固有は adapter 配下のみ（AC-CISO-011）。CISO epic #10 の #12 以降はこの port 越しに runtime を使う。**agent-runtime（AI呼出し）とは別境界**で、共有語は "runtime" のみ。
- **Shared Kernel**: 各状態コンテキストは `domain`（契約・状態機械）と `store`（Eval DB）を共有する。契約が Published Language として境界を跨ぐ唯一の語彙。

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
