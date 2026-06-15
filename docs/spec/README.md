# 仕様ワークスペース (docs/spec)

本ディレクトリは、AI組織運用ハーネスの **モジュール別 詳細仕様** を一つずつ確定して
いくための作業台である。

- 要求の **正本** は リポジトリ直下の [`../../REQUIREMENTS.md`](../../REQUIREMENTS.md)。
  本書および各モジュール仕様は常に正本を参照し、矛盾する場合は正本が優先する。
- 現在の実装（`src/`・`agents/`・`docs/ARCHITECTURE.md` 等の AgentOps MVP）は
  **参考** 扱い。仕様を実装に合わせるのではなく、実装を仕様に合わせる。
- 本書は「大枠」を固定するための地図であり、各モジュールの中身は
  [`modules/`](modules/) 配下で一枚ずつ確定する（後述の優先順位順）。

## この文書の役割

```text
REQUIREMENTS.md         ← 要求の正本（大枠 / 全FR）
  └─ docs/spec/README.md   ← 本書: モジュール地図・契約カタログ・優先順位・テンプレート
       └─ docs/spec/modules/<module>.md   ← 各モジュールの詳細仕様（一つずつ確定）
```

確定の進め方:

1. 本書でモジュール分割・契約・優先順位を **大枠として固定**（このステップ）。
2. 優先順位の高いモジュールから順に `modules/<module>.md` を 1 枚ずつ起票し、
   テンプレート（§6 モジュール仕様テンプレート）に沿って要件を確定する。
3. 確定のたびに本書の「仕様状態」列と §7 進行チェックリスト
   を更新する。

> モジュールを横断する設計決定は [`decisions/`](decisions/) に決定記録（ADR）として
> 凍結する。各モジュール仕様・実装はこれに従う。
> 現行: [0001 オーサリング層と実行層の分離・spec.md を SoT とする](decisions/0001-authoring-execution-split.md)。

## 1. 大枠（レイヤーと原則）

```text
Human
  ↓                         ┌─ 上位レイヤー（新規）
Hermes-agent  ──────────────┤  意図分類・契約化・ルーティング・進捗統合・改善提案
  ↓ Intake / Routing / Department Contract
Development Department ──────┤  単体でも動作可能な能力モジュール（既存 AgentOps 相当）
  Coordinator → Planner → Generator → Evaluator → Repair → Release
  ↓ Issue / PR
Evaluation Harness ─────────┤  Registry / 隔離実行 / Graders / Evidence / Metrics
  ↓ Scorecard / Evidence
Dashboard ──────────────────┘  可視化
  ↑ daily report / metrics / failure → Hermes が統合し人間へ
```

設計の固定点（正本 §3・§25 抜粋。各モジュール仕様はこれを不変条件として扱う）:

- **契約ベース**: モジュール間は自然言語ではなく構造化契約で受け渡す。
- **部署は単体動作可能**: 開発部署は Hermes なしでも `IssueContract` から回せる。
- **Coordinator は通常コード**: 状態遷移・ロック・dispatch は LLM にやらせない。
- **Evaluator は Generator から独立**: 合否は会話ではなく scorecard + evidence で決まる。
- **frozen contract を実装後に変更しない**。
- **source of truth は永続ストア**（GitHub Issue/PR・契約・eval run・evidence・metrics）。
  会話履歴やエージェントの内部記憶は source of truth にしない。

## 2. モジュール・カタログ

`状態` の凡例 — **未着手**: 仕様未起票 / **下書き**: modules 配下に起票済み・確定前 /
**確定**: レビュー済みで固定。`参考実装` は現行 AgentOps の該当箇所（流用または置換の起点）。

### 2.1 上位レイヤー

| ID | モジュール | 主責務 | 正本 | 参考実装 | 状態 |
| --- | --- | --- | --- | --- | --- |
| M01 | 共通契約モデル (Contracts) | 契約エンベロープ・ID規約・frozen・validation方針 | §3.1, §4, §18 | `src/domain/schema.ts`（部分） | 未着手 |
| M02 | Hermes-agent | 進捗統合（現フェーズの実体）。受付・意図分類・契約生成はオーサリング層(M20)へ移動、部署ルーティングは二部署目まで縮退。改善提案・承認検出。**execution・dispatch を持たない**（issue ポーリングは M03: D2/D3） | §7, ADR-0001 | なし（新規） | 未着手（ADR-0001 で縮小） |
| M20 | オーサリング層 / spec.md 契約 | 人間+AI 協業で spec.md（受け入れ要件 AC-ID）・manual-requirements.md（MR-ID）作成 → `contract-approved` 署名。Department への入力契約（最上流） | ADR-0001 | `templates/feature-spec.md`, `templates/acceptance.yaml`, `templates/manual-requirements.md` | 下書き（v2） |

### 2.2 開発部署 (Development Department)

| ID | モジュール | 主責務 | 正本 | 参考実装 | 状態 |
| --- | --- | --- | --- | --- | --- |
| M03 | Development Coordinator | 状態機械（二段: ADR-0001 §5）・実行ループ保持・**contract-approved issue の直接ポーリング**・**human_review ゲート（タグ + 層別差し戻し: D17）**・ラベル排他・ロック・worktree・agent dispatch（通常コード） | §9, §10, ADR-0001 | `src/pipeline/coordinator.ts`, `src/domain/states.ts`, `templates/labels.yaml` | 未着手 |
| M04 | Roadmap Planner | Roadmap/Epic 整理・分解 | §8.2, §9.1 | `agents/roadmap-planner.md`, `src/planning/planner.ts` | 未着手 |
| M05 | Issue Contract Planner（resolve に縮小） | **resolve のみ**: spec.md@gitSha の AC + acceptance.yaml + M21 設計スライス → IssueContract（埋め込まない: ADR-0001 D8）。設計・分解は M21 へ移譲（D13） | §11, ADR-0001 | `agents/issue-planner.md`, `src/planning/planner.ts` | 未着手 |
| M21 | Design Planner（新規） | approved spec.md → 詳細設計（Tier1 アーキ・スパイン=epic 共有 / Tier2 設計スライス=PR サイズ）+ PR サイズへ issue 分解（β）。AI 著者・人間 override 任意（ADR-0001 D13/D14/D16） | ADR-0001, §11, §12 | `agents/issue-planner.md`（分割元） | 下書き |
| M06 | Generator + Adapters | 実装・PR・GeneratorHandoff / Claude(interactive)・Codex・Gemini adapter | §12 | `agents/generator.md`, `src/agents/{runner,cli,mock}.ts` | 未着手 |
| M07 | Evaluator | 独立評価・scorecard・PR review・repair instruction 投稿 | §13 | `agents/evaluator.md`, `src/pipeline/evaluate.ts` | 未着手 |
| M08 | Repair Router | scorecard → 修正指示・試行回数管理・上限超過時 escalate | §14 | `agents/repair-router.md`, `src/pipeline/repair.ts` | 未着手 |
| M10 | Eval Curator | false pass の回帰昇格・failure taxonomy | §16 | `agents/eval-curator.md`, `src/pipeline/curator.ts` | 未着手 |
| M11 | Release Manager | approve → リリース候補化・merge は人間承認必須 | §8.2, §9.3, §20 | `agents/release-manager.md` | 未着手 |
| M12 | Harness Analyst | metrics/失敗傾向 → harness/eval 改善 Issue 化 | §3.4, §17 | `agents/harness-analyst.md`, `src/pipeline/analyst.ts` | 未着手 |

### 2.3 評価ハーネス

| ID | モジュール | 主責務 | 正本 | 参考実装 | 状態 |
| --- | --- | --- | --- | --- | --- |
| M09 | Evaluation Harness | Eval Task Registry / 隔離実行環境 / 3段階Graders / Evidence Store / 非決定性Metrics | §15 | `src/graders/index.ts`, `src/metrics/metrics.ts`, `.harness/evidence/` | 未着手 |

### 2.4 可視化・改善

| ID | モジュール | 主責務 | 正本 | 参考実装 | 状態 |
| --- | --- | --- | --- | --- | --- |
| M13 | Dashboard & Metrics | Roadmap/Agent/Eval品質/Evidence の4ビュー | §17 | `src/dashboard/dashboard.ts`, `src/metrics/metrics.ts` | 未着手 |
| M14 | Daily Report & Improvement Proposal | 日報集約・改善提案（skill/agent/grader） | §7.8, §7.9, §24 Phase6 | なし（新規） | 未着手 |

### 2.5 横断・基盤

| ID | モジュール | 主責務 | 正本 | 参考実装 | 状態 |
| --- | --- | --- | --- | --- | --- |
| M15 | Security & Approval | 承認必須操作・secret管理・agent権限分離 | §7.10, §20 | 一部暗黙 | 未着手 |
| M16 | Model Independence & Config | provider/model 切替・capability・schema validation+retry | §7.11, §6.1 | `.harness/config.json`（部分） | 未着手 |
| M17 | CLI | `harness hermes/dev/dashboard` サブコマンド | §22 | `src/cli/index.ts` | 未着手 |
| M18 | Storage / Source of Truth | spec.md=オーサリング SoT / issue・PR=実行 SoT の二層（ADR-0001 D4/D5）・永続ストア・GitHub backend 抽象・resume | §5.2, §6.4, ADR-0001 | `src/store/store.ts`（JSON） | 未着手 |
| M19 | Department / Handoff 抽象（将来） | Department interface・Handoff Contract・他部署 sample | §3.2, §3.3, §18.2, §19 | なし（新規） | 未着手 |

## 3. 契約カタログ

モジュール間を接続する契約。詳細フィールドは各契約の **主担当モジュール** の仕様確定時に
同時に固定する（契約は単独で完成させず、producer/consumer の要件と一緒に固める）。

| 契約 | producer → consumer | 正本 | 既存schema | 状態 |
| --- | --- | --- | --- | --- |
| IntakeContract | Hermes → Hermes(routing) | §7.4 | なし | 新規 |
| RoutingDecision | Hermes → Coordinator | §7.5 | なし | 新規 |
| DepartmentContract | Hermes → Department | §7.6, §18 | なし | 新規 |
| spec.md（AC behavior） | 人間+AI → M21 | ADR D4/D15 | `templates/feature-spec.md` | 確定（M20 v2） |
| acceptance.yaml（AC-ID→verification） | M20 → M05(resolve) | ADR D15 | `templates/acceptance.yaml` | 確定（M20 v2） |
| ApprovedSpecRef（path+gitSha+acFingerprints） | M20 → M21/M05 | ADR D8/O2/O3 | なし | 確定（M20 v2） |
| ArchitectureSpine（Tier1・決定のみ） | M21 → M05/Generator | ADR D14 | なし | 下書き（M21） |
| DesignSlice（Tier2・PR サイズ） | M21 → M05 | ADR D14 | なし | 下書き（M21） |
| IssueSpawnOrder（参照集合・版固定） | M21 → M03/M05(resolve) | ADR D8/D13 | なし | 下書き（M21） |
| IssueContract | M05(resolve) → Generator/Evaluator | §11.2 | `IssueContract` | 既存・差分あり（resolve 派生物に） |
| GeneratorHandoff | Generator → Evaluator | §12.3 | `BuildArtifact`（近似） | 部分・要正式化 |
| EvalScorecard | Evaluator → Repair/DB | §13.3 | `EvalRun` | 既存・差分あり |
| RepairInstruction | Evaluator/Repair → Generator | §13.5, §14.1 | repair brief（`pipeline/repair.ts`） | 部分 |
| EvalTask | Curator → Registry | §15 EVAL-FR-001 | `EvalTask` | 既存・差分あり |
| Artifact（汎用） | 任意 agent | §18.1 | なし | 新規 |
| DailyReport | Department → Hermes | §7.8 | なし | 新規 |
| ImprovementProposal | Hermes/Analyst | §7.9 | なし | 新規 |
| HandoffContract | Department → Department | §3.3, §18.2 | なし | 新規（将来） |
| Permissions / Approval policy | 横断 | §20 | なし | 新規 |
| Model config | 横断 | §7.11 | `config.json`（部分） | 部分 |

差分注意（既存契約と正本のズレ。確定時に解消方針を決める）:

- 命名規約: 既存 schema は camelCase、正本の YAML 例は snake_case。
- `IssueContract`: 正本には `tech_stack` と `verification.steps` があるが既存schemaに無い。
- `EvalScorecard`: 正本は blocking/non-blocking を分離、既存 `EvalRun` は `findings` 統合 +
  `severity`。`hard_gates` の項目集合も要整合。
- `IssueContract`: `Issue.contract` 埋め込み → `specRef`(path+gitSha)+`acceptanceCriteriaIds`
  参照に置換（ADR-0001 D8）。契約は dispatch 時に M05 が spec.md@gitSha から resolve する派生物。
- ADR-0001 で導入した新規契約（spec.md / acceptance.yaml / ApprovedSpecRef / ArchitectureSpine /
  DesignSlice / IssueSpawnOrder）は上表に正式行として収載。M20 産は確定 v2、M21 産は下書き。

## 4. 参考実装（AgentOps）とのギャップ分析

「実装を仕様に合わせる」ための差分の俯瞰。詳細は各モジュール仕様で確定する。

### 4.1 流用できる（既に存在）

```text
- IssueContract / EvalRun(=Scorecard) / EvalTask / Roadmap・Epic・Issue / PR / Finding
- 状態機械(states.ts) と status ラベル(templates/labels.yaml)
- Graders: hard gates → composite score（blocker優先のverdict）
- Evidence store（.harness/evidence/<run>/）
- Metrics: pass@1 / pass@k / pass^k（不偏推定）/ area×failure heatmap / cost
- Eval Curator / Harness Analyst / Dashboard(HTML) / CLI(agentops) / JSON store
- CLI runner adapter（cli.ts: claude/codex/gemini をコマンド差し替えで起動）
```

### 4.2 新規（正本で追加され、現状ほぼ無い）

```text
- Hermes-agent 一式（intake / intent / 抽象度 / routing / progress / proposal / approval）
- IntakeContract / RoutingDecision / DepartmentContract / Artifact(汎用) /
  DailyReport / ImprovementProposal(schema) / HandoffContract
- Department / Handoff 抽象と他部署 sample（将来拡張）
- 承認ゲート・permissions・secret 管理の明文化（SEC-FR）
- モデル独立性の config 化（provider/capability/retry）
- GeneratorHandoff の正式契約化
- 隔離実行環境（fresh worktree / clean DB / seed）と実 grader（実コマンド実行）
- false-pass / false-fail / flaky の追跡
- Coordinator のロック / worktree / dispatch（現状は逐次・JSON）
- adapter 群（claude-interactive / codex / gemini / local-eval の個別化）
- GitHub backend（現状ローカル JSON）
```

### 4.3 最大の未確定領域（要注意）

正本が「mock と production の間に立つ最大の壁」と位置づける箇所:

- **M09 隔離実行環境 + 実 grader**: 現状 grader は「記述された artifact」を採点する mock。
  実 checkout に対し `npm test`/Playwright を走らせる形が未実装。
- **M02 Hermes 全体**: 新規。上位レイヤーは概念のみで実装が無い。
- **M15 承認 / 権限**: red lines は文章化済みだが、強制する仕組みが無い。

## 5. スコープ境界（実装する / しない）

正本 §2 の再掲（モジュール仕様はこの境界を越えないこと）。

実装する: Hermes / 開発部署 / GitHub Issue・PR ハーネス / 評価ハーネス / 修正ループ /
日報・進捗・改善提案の基盤 / ダッシュボード基礎 / Department interface（抽象のみ）。

実装しない: 動画・SNS・調査・バックオフィス各部署の worker / 外部SNS自動投稿 /
画像・動画生成 / 広告運用 / 本番デプロイ完全自動化 / 人間承認なしの外部公開 /
Claude Code headless mode。他部署は **sample 契約と interface のみ** 可。

## 6. モジュール仕様テンプレート

各 `modules/<module>.md` は以下の構成で起票する（節は省略可、ただし 1・2・3・5・7・8 は必須）。

```markdown
# <ID> <モジュール名> 仕様

- 正本参照: REQUIREMENTS.md §x（FR-IDを列挙）
- 参考実装: <path>（流用 / 置換 / 破棄の別）
- 仕様状態: 未着手 | 下書き | 確定
- 最終更新: YYYY-MM-DD

## 1. 目的とスコープ境界
何を担い、何を担わないか。隣接モジュールとの責務の切れ目。

## 2. 入力契約 (consumes)
受け取る契約／成果物と、その必須フィールド・前提条件。

## 3. 出力契約 (produces)
生成する契約／成果物のスキーマと不変条件。

## 4. 振る舞い / 処理フロー
正常系・異常系のステップ。状態遷移があれば明記。

## 5. 機能要件 (FR)
正本の FR-ID ごとに「確定/未確定」と確定内容。新規FRはここで採番。

## 6. 非機能要件
決定性・性能・コスト・モデル独立性・可観測性 等。

## 7. 不変条件・禁止事項 (red lines)
このモジュールが絶対に破ってはならないこと。

## 8. 受け入れ条件 (testable)
完了を検証する具体条件（正本 §23 の MVP-AC と対応づける）。

## 9. 既存実装とのギャップ / 移行方針
参考実装との差分と、合わせ込みの方針。

## 10. 未決事項 / 決定ログ
open question と、解消した決定の記録（日付つき）。
```

## 7. 進行チェックリスト

優先順位は §8 推奨優先順位（提案）の初期値。確定のたびに状態を更新する。

- [ ] M20 オーサリング層 / spec.md 契約（下書き v2・O1 反転完了 / 敵対レビューで drift 二段化・gitSha 永続先・status 派生を再修正）
- [ ] M21 Design Planner（ADR-0001・詳細設計二層化 + 分解 / 下書き）
- [ ] M01 共通契約モデル
- [ ] M02 Hermes-agent（ADR-0001 で進捗集約に縮小・dispatch 不在）
- [ ] M03 Development Coordinator
- [ ] M05 Issue Contract Planner（+ IssueContract 確定）
- [ ] M06 Generator + Adapters（+ GeneratorHandoff 確定）
- [ ] M07 Evaluator ＋ M09 Evaluation Harness（+ Scorecard 確定）
- [ ] M08 Repair Router
- [ ] M10 Eval Curator（+ Failure taxonomy）
- [ ] M13 Dashboard & Metrics
- [ ] M12 Harness Analyst ＋ M14 Daily Report / Improvement Proposal
- [ ] M15 Security & Approval ／ M16 Model Independence（横断）
- [ ] M11 Release Manager ／ M17 CLI ／ M18 Storage
- [ ] M04 Roadmap Planner
- [ ] M19 Department / Handoff 抽象（将来・抽象のみ）

## 8. 推奨優先順位（北極星整合・スライス順）

モジュールの線形順ではなく、[北極星](../NORTH_STAR.md)の三能力（**自律 × 評価 × 改善**）を閉じる
**ループを薄く1本通し、太らせる**順で並べる。

> **「同格」の解釈**: 北極星は三能力を同格とするが、これは同時着工ではなく **いずれも恒久的に後回しに
> しない＝最初のループが三能力すべてに触れる**こと。サイクルはどこかで bootstrap が要り、データフロー上は
> 自律→評価→改善 に依存するが、**loop 1 で閉じる**。これにより操舵の最優先点（同じ失敗を二度繰り返さない
> ＝失敗を回帰化）を loop 1 から守る。
>
> **旧 §8 の緊張の解消**: (a) 旧版は M01 を1番目に置いたが ADR-0001 D1「抽象は具体の後」と矛盾した →
> **M01 は loop 1 で現れた契約から抽出**（垂直1本の後）。(b) 旧版は改善系（M10/M12/M14）を 8・10 番目に
> 置き北極星と乖離した → **失敗の回帰化は loop 1 に含む**（M10 Curator は薄く）。プロセス改善提案
> （M12/M14）は loop 2 の厚み付けに回す。

### Loop 1 — 三能力を閉じる最薄の縦1本（最優先）

すべて「薄く」。各モジュールを作り込むのではなく**ループを閉じる**ことが目的。

- **自律**: M20 spec.md → M21 設計/分解 → M05 resolve → M03 Coordinator（薄）→ M06 Generator → PR。
- **評価**: M07 Evaluator + M09 Harness（薄・実 grader 1〜2種）→ scorecard / evidence。
- **改善**: M08 Repair（薄・生成↔評価を閉じる）/ M10 Eval Curator（薄・**loop 1 の失敗を回帰 eval に昇格**）。

loop 1 の完了基準: 1 機能が人間の HOW 無しで PR 化され、証拠で採点され、**その失敗が回帰ケースとして
捕捉される**（北極星の反証「失敗が回帰化されない」を loop 1 で潰す）。

### 抽出 — M01 共通契約モデル（loop 1 の直後）

loop 1 で**実際に現れた契約**（IssueContract / Scorecard / spec.md / ApprovedSpecRef / IssueSpawnOrder /
DesignSlice 等）から、共通エンベロープ・ID 規約・frozen・validation・version-pinned Ref を**抽出**して
固定する（ADR D1）。先に作ると偽の汎用性になる。

### Loop 2+ — 各能力を太らせる

- **自律**: M02 Hermes（進捗集約）/ M11 Release Manager / M04 Roadmap Planner。
- **評価**: M09 隔離実行・実 grader 群の拡充（最大の未確定領域）/ M13 Dashboard & Metrics。
- **改善**: M12 Harness Analyst + M14 Daily Report / Improvement Proposal（プロセス改善提案）。
- **横断**: M15 Security & Approval / M16 Model Independence / M17 CLI / M18 Storage。
- **将来**: M19 Department / Handoff 抽象（interface + sample 契約のみ）。

> 次アクション: 垂直1本（M20 v2 → M21 → **M05 resolve**）の続きとして M05 を起票。loop 1 を閉じてから
> M01 を抽出する。順番の入れ替え・粒度変更があれば指定する。
