# AI組織運用ハーネス 要求仕様書（draft・参考）

> **この文書は正本ではない。** 2026-06-25 に root から `draft/_spec/` へ降格した（旧 AgentOps 期の広域要求で、
> 「今やりたいこと」の正本としては粗く、正本が複数あるように見える原因だったため）。
> **最上位要求は北極星** [`../../docs/NORTH_STAR.md`](../../docs/NORTH_STAR.md)、**確定 SoT は to-spec スキルの生成物**
> （`spec.md` + `acceptance.yaml`）。本書は to-spec の Intake が読む**上流決定 doc / 参考**として残す。現在の実装
> （`src/`・`agents/`・`docs/ARCHITECTURE.md` 等の AgentOps MVP）も参考。見出し階層のみ整形済み（内容は不変）。

## 0. 文書の目的

本仕様書は、**Hermes-agent を人間向けの上位インターフェースとして置き、その下に開発エージェント群を接続する AI 組織運用ハーネス**を構築するための要求を定義する。

本実装の主対象は以下の2つである。

```text
1. Hermes-agent
   人間の自然言語指示を受け、意図分類・契約化・部署ルーティング・進捗統合・改善提案を行う上位エージェント。

2. 開発エージェント群
   GitHub Issue / PR / 評価ハーネスを中心に、計画・実装・評価・修正・リリース候補化を行う開発部署。
```

動画制作部署、SNS運用部署、調査部署などの他部署は、将来拡張の例として扱う。
本仕様の実装対象には含めない。

---

## 1. 背景と目的

### 1.1 Why

Codex、Claude Code、Gemini などのコーディングエージェントは単体でも有用だが、長期的・継続的な開発では以下の問題が起こりやすい。

```text
- 指示が曖昧なまま実装される
- スコープが膨らむ
- 評価基準が実装後に曖昧になる
- テストやレビューが一貫しない
- エージェントの失敗が学習データとして残らない
- 複数エージェントの進捗が人間にとって追いにくい
```

この問題を解決するために、自然言語の依頼をそのまま実装に流すのではなく、以下の流れを構築する。

```text
人間の依頼
  ↓
Hermes-agent による意図分類・契約化・ルーティング
  ↓
開発エージェント群による Issue / PR ベースの作業
  ↓
評価ハーネスによる証拠付き判定
  ↓
修正ループ
  ↓
評価結果・失敗傾向・改善提案の蓄積
```

### 1.2 What

構築するものは、単なるコーディング補助ツールではなく、**AIエージェントを使った開発運用ハーネス**である。

対象は以下を含む。

```text
- Hermes-agent
- 開発部署としてのエージェント群
- 契約ベースのタスク受け渡し
- GitHub Issue / PR ベースの状態管理
- 評価ハーネス
- 修正ループ
- 日報・進捗・失敗ログ
- ダッシュボード
- エージェント / スキル / 評価基準の改善提案
```

### 1.3 How

初期実装はローカルファーストで行う。

```text
- GitHub Issue / PR を source of truth とする
- ローカルプロセスまたは tmux で複数エージェントを起動できる
- Claude Code は headless mode を使用しない
- Codex / Gemini など非対話実行可能なものは adapter 経由で扱う
- 評価はテスト、Playwright、scorecard、evidence artifact に基づく
- Hermes は実装や評価を直接代行せず、契約化・ルーティング・統合を担う
```

---

## 2. スコープ

### 2.1 実装対象

本仕様で実装する対象は以下である。

```text
- Hermes-agent の要求受付・意図分類・契約生成・ルーティング
- 開発エージェント群のワークフロー
- GitHub Issue / PR ベースの開発ハーネス
- 評価ハーネス
- 修正ループ
- 日報・進捗・改善提案の基盤
- ダッシュボードの基礎
- 将来の部署拡張に備えた Department interface
```

### 2.2 実装対象外

以下は本仕様の実装対象外とする。

```text
- 動画制作エージェント群の実装
- SNS運用エージェント群の実装
- 調査エージェント群の実装
- 外部SNSへの自動投稿
- 動画生成・画像生成パイプライン
- 広告運用
- 本番デプロイの完全自動化
- 人間承認なしの外部公開
- Claude Code headless mode の利用
```

ただし、動画制作部署、SNS運用部署、調査部署などは、将来拡張の例として型・概念・サンプル契約のみ定義してよい。

---

## 3. 基本原則

### 3.1 Contract-based interaction

Hermes と各部署、部署と部署、部署と評価ハーネスは、自然言語の曖昧な依頼ではなく、構造化された契約に基づいてやり取りする。

主な契約は以下。

```text
- Intake Contract
- Department Contract
- Issue Contract
- Handoff Contract
- Evaluation Contract
- Improvement Contract
```

### 3.2 Department as standalone capability

各部署は Hermes の内部部品ではなく、単体で動作可能な能力モジュールである。

```text
人間 → 開発部署
```

でも、

```text
人間 → Hermes → 開発部署
```

でも、同じ Department interface を通じて動作する。

Hermes が存在しなくても、開発部署は Issue Contract を受け取って、実装・PR・評価・修正ループを回せる必要がある。

### 3.3 Cross-department collaboration via artifacts and handoffs

部署は縦割りではない。

複数部署にまたがる業務は、成果物と Handoff Contract を介して連携する。

例:

```text
調査部署の research brief
  ↓
動画制作部署の script / storyboard
  ↓
SNS部署の post calendar
```

本実装では開発部署のみを構築対象とするが、将来の部署連携に備えて Handoff Contract の仕組みは定義する。

### 3.4 Continuous evaluation and improvement

Hermes、開発部署、Generator、Evaluator、評価ハーネス、部署間 handoff はすべて改善対象である。

失敗は単に修正するだけでなく、以下へ反映する。

```text
- 評価ケース
- Grader
- Prompt
- Skill
- Routing rule
- Issue Contract schema
- Dashboard metric
- 新エージェント提案
```

---

## 4. 用語定義

| 用語                     | 定義                                                       |
| ---------------------- | -------------------------------------------------------- |
| Hermes-agent           | 人間の窓口となる上位エージェント。意図分類、契約生成、部署ルーティング、進捗統合、改善提案を行う。        |
| Department             | 単体で動作可能な能力モジュール。例: 開発部署、動画制作部署、SNS部署。                    |
| Development Department | 本仕様で構築する開発エージェント群。Issue / PR / Eval に基づき動作する。            |
| Coordinator            | 状態遷移、ロック、dispatch、ラベル更新などを行う決定的プログラム。LLM ではなく通常コードで実装する。 |
| Agent                  | Planner、Generator、Evaluator などの専門役割。                     |
| Skill                  | Agent が使う再利用可能な手順・プロンプト・ツールセット。                          |
| Contract               | 目的、入力、成果物、制約、評価基準、承認条件を含む構造化依頼。                          |
| Artifact               | Agent または Department が生成した成果物。                           |
| Evaluation Harness     | 成果物を評価し、証拠付きの scorecard を生成する仕組み。                        |
| Grader                 | 評価ハーネス内で採点を行う構成要素。決定的 grader、LLM grader、人間 grader がある。   |
| pass@k                 | k 回の試行のうち 1 回でも成功する確率。探索力を見る。                            |
| pass^k                 | k 回の試行すべてが成功する確率。安定性を見る。                                 |

---

## 5. 全体アーキテクチャ

### 5.1 概念図

```text
Human
  ↓
Hermes-agent
  ↓
Intake Contract
  ↓
Routing Decision
  ↓
Department Contract
  ↓
Development Department
  ├─ Roadmap Planner
  ├─ Issue Contract Planner
  ├─ Generator
  ├─ Evaluator
  ├─ Repair Router
  ├─ Eval Curator
  └─ Release Manager
  ↓
GitHub Issue / PR
  ↓
Evaluation Harness
  ↓
Scorecard / Evidence / Metrics
  ↓
Dashboard
  ↓
Hermes-agent による進捗統合・改善提案
```

### 5.2 実装上の source of truth

以下を永続的な source of truth とする。

```text
- GitHub Issue
- GitHub PR
- Git commits
- Contract files
- Eval run records
- Scorecards
- Evidence artifacts
- Dashboard metrics DB
```

Hermes の会話履歴や各エージェントの内部記憶は、source of truth にしてはならない。

---

## 6. 実装前提

### 6.1 利用するコーディングエージェント

本ハーネスは、以下のような既存コーディングエージェントを利用する前提とする。

```text
- Codex
- Claude Code
- Gemini
```

ただし、特定の1モデルや1サービスに強く依存してはならない。

### 6.2 Claude Code の制約

Claude Code については以下を前提とする。

```text
- headless mode は使わない
- interactive session として利用する
- tmux などで常駐させてもよい
- 自動化は prompt file、worktree、GitHub Issue / PR、hook、手動承認を通じて行う
```

「headless mode は使わない」の一次理由は **従量課金の回避**。`claude -p` / Agent SDK 経由の起動は従量課金の対象であり
（利用そのものの従量化も Anthropic がアナウンス済み — 当初 2026-06-15 予定・現在は延期）、定額枠の interactive session
内で完結させてコストを固定する。

### 6.3 tmux の扱い

tmux は必須ではない。

```text
tmux の役割:
  - 複数プロセスの監視
  - Claude Code interactive session の管理
  - 手動介入しやすい実行環境

tmux が担ってはいけない役割:
  - source of truth
  - 状態管理
  - 契約保存
  - 評価履歴保存
```

tmux がなくても、各 worker process が別プロセスとして起動できればよい。

### 6.4 GitHub の扱い

GitHub Issue / PR を中心に状態を管理する。

```text
Issue:
  - Roadmap
  - Epic
  - Feature
  - Bug
  - Harness improvement
  - Eval improvement
  - Issue Contract

PR:
  - Generator の成果物
  - Evaluator の review 対象
  - 修正ループの単位

PR Review:
  - 評価結果
  - scorecard
  - repair instruction
```

---

## 7. Hermes-agent 要件

### 7.1 Hermes の役割

Hermes-agent は、人間と AI 組織の間に立つ上位インターフェースである。

主な責務は以下。

```text
- 人間の自然言語指示を受け取る
- 意図を分類する
- 要求の抽象度を判定する
- Intake Contract を作成する
- 適切な部署に Department Contract を発行する
- 開発依頼の場合、開発部署へルーティングする
- 進捗を統合して人間へ報告する
- 日報を読み、ボトルネックや改善候補を抽出する
- 新しい agent / skill / grader / workflow を提案する
- 人間承認が必要な判断を検出する
```

### 7.2 Hermes がやってはいけないこと

Hermes-agent は以下を行ってはならない。

```text
- コードを直接実装する
- 評価ハーネスを迂回して合否を決める
- PR を独断で merge する
- 本番 deploy を独断で行う
- 外部公開を独断で行う
- 評価基準を勝手に緩める
- Contract を実装後にこっそり変更する
- 自分の記憶だけを source of truth にする
```

### 7.3 Hermes 機能要件

#### HERMES-FR-001: 人間からの要求受付

Hermes は人間から自然言語の依頼を受け取る。

入力例:

```text
ログイン周りを改善したい
PR #42 の評価指摘を直して
来週のリリースに向けて告知準備をしたい
最近 Evaluator が甘い気がする
```

出力は自由文だけでなく、構造化された `IntakeContract` を含むこと。

#### HERMES-FR-002: 意図分類

Hermes は依頼を以下の intent type に分類する。

```yaml
intent_types:
  - roadmap_planning
  - epic_decomposition
  - issue_contract_creation
  - feature_implementation
  - bug_fix
  - pr_review
  - repair_loop
  - release_request
  - eval_harness_improvement
  - dashboard_analysis
  - daily_report_review
  - skill_proposal
  - agent_proposal
  - human_decision_required
  - other_department_example
```

本実装で処理対象にするのは主に以下。

```text
- roadmap_planning
- epic_decomposition
- issue_contract_creation
- feature_implementation
- bug_fix
- pr_review
- repair_loop
- eval_harness_improvement
- dashboard_analysis
- daily_report_review
- skill_proposal
- agent_proposal
```

`other_department_example` は将来拡張の例示として扱い、実行対象にはしない。

#### HERMES-FR-003: 抽象度判定

Hermes は依頼がどの階層に属するか判定する。

```text
- Business Request
- Roadmap
- Epic
- Feature Issue
- Bug Issue
- PR Repair
- Eval Improvement
- Harness Improvement
```

例:

```text
「ログイン周りをちゃんとしたい」
  → Epic または Roadmap レベル

「Issue #123 を実装して」
  → Feature Issue レベル

「PR #42 の指摘を直して」
  → PR Repair レベル
```

#### HERMES-FR-004: Intake Contract 生成

Hermes は依頼ごとに `IntakeContract` を生成する。

```yaml
intake_contract:
  id: "IC-YYYYMMDD-001"
  raw_request: "ログイン周りを改善したい"
  interpreted_goal: "認証・アカウント体験の改善方針を整理する"
  intent_type: "epic_decomposition"
  target_layer: "epic"
  primary_department: "development"
  supporting_departments: []
  confidence: 0.78
  needs_human_confirmation: true
  reasons:
    - "要求が広く、単一 Issue にするには大きすぎる"
    - "認証方式、UX、セキュリティ、DB設計に影響する"
  proposed_next_action:
    type: "create_epic_draft"
    target_agent: "roadmap_planner"
```

#### HERMES-FR-005: ルーティング判断

Hermes は `IntakeContract` に基づき、次の routing decision を生成する。

```yaml
routing_decision:
  id: "RD-YYYYMMDD-001"
  intake_contract_id: "IC-YYYYMMDD-001"
  target_department: "development"
  target_workflow: "epic_to_issue_contract"
  next_agent: "issue_planner"
  github_action:
    type: "create_issue"
    labels:
      - "type:epic"
      - "status:ready-for-contract"
      - "agent:planner"
  requires_human_confirmation: true
```

実際の GitHub 操作は Hermes が直接行ってもよいが、望ましくは Coordinator に渡す。

#### HERMES-FR-006: Department Contract 発行

Hermes は対象部署に対して `DepartmentContract` を発行する。

開発部署向けの例:

```yaml
department_contract:
  id: "DC-DEV-YYYYMMDD-001"
  target_department: "development"
  request_type: "feature_implementation"
  goal:
    business_goal: "ユーザーがタスクを作成・管理できるようにする"
    user_value: "日々の作業を管理できる"
  inputs:
    - type: "product_request"
      artifact_id: "IC-YYYYMMDD-001"
  expected_outputs:
    - type: "github_issue"
    - type: "issue_contract"
    - type: "pull_request"
    - type: "eval_scorecard"
  constraints:
    source_of_truth: "github"
    no_contract_relaxation_without_approval: true
    no_external_publish_without_approval: true
  evaluation_required: true
```

#### HERMES-FR-007: 進捗統合

Hermes は GitHub Issue、PR、scorecard、daily report、metrics を読み、進捗を統合して人間に返す。

出力例:

```text
現在の状況:

- 開発:
  - Epic E01: 5件中2件完了
  - Issue #123: PR #45 が評価待ち
  - PR #42: 評価失敗。AC-003 の永続化条件に違反

- 評価ハーネス:
  - Playwright の flaky test が2件
  - false pass 疑いが1件

人間判断が必要:
  - 認証方式を email/password に限定するか、OAuth も含めるか
```

#### HERMES-FR-008: 日報集約

Hermes は各部署の日報を読み、以下を抽出する。

```text
- 完了事項
- 進行中事項
- ブロッカー
- 繰り返し失敗
- 評価ハーネスの不足
- 新 skill 候補
- 新 agent 候補
- workflow 改善候補
```

本実装では開発部署の日報を対象にする。
他部署の日報はサンプル schema のみ提供する。

#### HERMES-FR-009: 改善提案

Hermes は日報、評価結果、失敗ログから改善提案を作る。

```yaml
improvement_proposal:
  id: "IP-YYYYMMDD-001"
  proposal_type: "new_skill"
  target_department: "development"
  proposed_name: "reload-persistence-eval-skill"
  reason:
    - "リロード後の永続化を Generator が複数回見落とした"
    - "Evaluator の Playwright scenario が不足していた"
  evidence:
    - eval_run_id: "EV-PR42-002"
    - finding_id: "F-AC003"
  expected_impact:
    - "false pass rate の低下"
    - "repair attempts の削減"
  requires_human_approval: true
```

#### HERMES-FR-010: 承認ゲート

Hermes は以下を人間承認必須として扱う。

```text
- main branch への merge
- production deploy
- 外部公開
- SNS投稿
- 有料広告出稿
- 重要ファイル削除
- 評価基準の緩和
- 新しい自律エージェントの作成
- 高コストな parallel generation
- セキュリティ関連変更の承認
```

#### HERMES-FR-011: モデル独立性

Hermes は特定モデルに固定してはならない。

要件:

```text
- model provider を設定ファイルで切り替え可能にする
- provider / model / temperature / max_tokens / capabilities を明示する
- Hermes 本体と worker agent で別モデルを使えるようにする
- 構造化出力が不安定なモデルの場合は schema validation と retry を行う
```

例:

```yaml
models:
  hermes:
    provider: "openai-compatible"
    model: "strong-reasoning-model"
    temperature: 0.2
    required_capabilities:
      - "long_context"
      - "structured_output"

  dev_generator:
    provider: "codex"
    model: "default"

  evaluator_llm:
    provider: "gemini"
    model: "review-oriented-model"
```

---

## 8. 開発エージェント群 要件

### 8.1 開発部署の目的

開発部署は、Hermes または人間から `DepartmentContract` / `IssueContract` を受け取り、以下を行う。

```text
- Roadmap / Epic / Issue の整理
- Issue Contract 作成
- Generator への割当
- 実装
- PR 作成
- Evaluator による評価
- 指摘に基づく修正
- scorecard 生成
- 評価結果の蓄積
- 改善提案
```

開発部署は Hermes がなくても単体で動作できること。

### 8.2 開発部署の構成

初期実装では以下の agent / component を持つ。

```text
Development Department
  ├─ Development Coordinator
  ├─ Roadmap Planner
  ├─ Issue Contract Planner
  ├─ Generator
  ├─ Evaluator
  ├─ Repair Router
  ├─ Eval Curator
  ├─ Release Manager
  ├─ Harness Analyst
  └─ Dashboard
```

MVP では最低限以下を実装する。

```text
- Development Coordinator
- Issue Contract Planner
- Generator adapter
- Evaluator
- Repair Router
- Eval Curator
- Dashboard minimum
```

---

## 9. 開発部署 ワークフロー

### 9.1 Roadmap / Epic / Issue 階層

開発作業は以下の階層で管理する。

```text
Roadmap
  ↓
Epic
  ↓
Issue Contract
  ↓
PR
  ↓
Eval Run
  ↓
Finding / Repair
```

注意:

```text
「スプリント」は1機能単位ではなく、時間枠として扱う。
1つのスプリントには複数 Epic / Issue / Bug / Harness improvement が含まれうる。
```

本ハーネスの実装単位は `Issue Contract` とする。

### 9.2 GitHub ラベル

以下のラベルを使う。

```text
type:roadmap
type:epic
type:feature
type:bug
type:harness
type:eval

status:planned
status:ready-for-contract
status:contract-drafted
status:ready-for-generation
status:generation-in-progress
status:ready-for-evaluation
status:evaluation-in-progress
status:changes-requested
status:approved
status:ready-to-merge
status:released
status:needs-human-review

agent:planner
agent:generator-claude
agent:generator-codex
agent:generator-gemini
agent:evaluator
agent:eval-curator

area:frontend
area:backend
area:eval
area:harness
area:docs
area:infra
```

同じ種類の `status:*` ラベルが同時に複数付かないようにする。

### 9.3 状態遷移

```text
Issue created
  ↓
status:ready-for-contract
  ↓
Issue Contract Planner
  ↓
status:ready-for-generation
  ↓
Generator
  ↓
PR created
  ↓
status:ready-for-evaluation
  ↓
Evaluator
  ├─ PASS
  │   ↓
  │ status:approved
  │   ↓
  │ Release Manager
  │   ↓
  │ status:released
  │
  └─ FAIL
      ↓
    status:changes-requested
      ↓
    Repair Router
      ↓
    Generator
      ↓
    PR updated
      ↓
    status:ready-for-evaluation
```

---

## 10. Development Coordinator 要件

### DEV-COORD-FR-001: 状態管理

Coordinator は GitHub Issue / PR のラベルを見て、次の処理対象を決定する。

Coordinator は LLM ではなく通常コードで実装する。

### DEV-COORD-FR-002: ロック管理

同じ Issue / PR を複数 worker が同時に処理しないようにする。

方法:

```text
- status ラベルの排他制御
- lock file
- local DB
- GitHub comment marker
```

いずれかを使用する。

### DEV-COORD-FR-003: worktree 管理

各 Issue / PR / attempt ごとに Git worktree を作成できること。

```text
.worktrees/
  issue-123-generator-claude/
  pr-45-evaluator/
```

### DEV-COORD-FR-004: Agent dispatch

Coordinator は対象 agent に応じて adapter を呼び出す。

```text
- Claude Code interactive adapter
- Codex adapter
- Gemini adapter
- Local evaluator adapter
```

---

## 11. Issue Contract Planner 要件

### DEV-PLAN-FR-001: Issue Contract 作成

Planner は曖昧な開発依頼から、評価可能な Issue Contract を作成する。

Issue Contract は GitHub Issue 本文、または repository 内の contract file として保存する。

### DEV-PLAN-FR-002: Issue Contract の標準形式

```yaml
issue_contract:
  id: "ISSUE-123"
  title: "タスク CRUD の基本実装"
  type: "feature"
  epic_id: "E01"

  product_goal:
    user_value: "ユーザーが日々の作業を管理できる"

  user_story:
    as_a: "ユーザー"
    i_want: "タスクを作成・一覧・編集・削除できる"
    so_that: "自分の作業を管理できる"

  scope:
    include:
      - "タスク作成"
      - "タスク一覧"
      - "タスク編集"
      - "タスク削除"
      - "完了状態切り替え"
      - "リロード後の永続化"
    exclude:
      - "認証"
      - "共有"
      - "通知"

  tech_stack:
    frontend: "React + Vite"
    frontend_tests: "Vitest"
    backend: "FastAPI"
    e2e: "Playwright"
    database: "SQLite"

  acceptance_criteria:
    - id: "AC-001"
      severity: "blocker"
      behavior: "ユーザーは新しいタスクを作成できる"
      verification:
        method: "playwright"
        steps:
          - "トップページを開く"
          - "タイトルに 'Buy milk' と入力する"
          - "Add ボタンを押す"
        expected:
          - "一覧に 'Buy milk' が表示される"
          - "ページをリロードしても 'Buy milk' が残る"

    - id: "AC-002"
      severity: "blocker"
      behavior: "API はタスクを永続化する"
      verification:
        method: "api_test"
        expected:
          - "POST /tasks が成功する"
          - "GET /tasks に作成済みタスクが含まれる"

  red_lines:
    - "local state のみで永続化したふりをしない"
    - "UI だけ存在して API が未実装"
    - "評価基準を実装後に緩めない"

  status: "frozen"
```

### DEV-PLAN-FR-003: Contract validation

Issue Contract は実装前に validation する。

必須条件:

```text
- acceptance criteria が存在する
- blocker criteria が明示されている
- 各 criterion に verification method がある
- include / exclude scope が明示されている
- red lines がある
- 実装後に勝手に変更できない
```

---

## 12. Generator 要件

### DEV-GEN-FR-001: 入力

Generator は以下を入力として受け取る。

```text
- Issue Contract
- 関連する product spec
- 既存コード
- 評価コマンド
- previous evaluator scorecard
```

### DEV-GEN-FR-002: 出力

Generator は以下を出力する。

```text
- 実装済みコード
- テスト
- commit
- pull request
- generator handoff
```

### DEV-GEN-FR-003: Generator Handoff

```yaml
generator_handoff:
  issue: 123
  pr: 45
  attempt: 1
  status: "ready_for_evaluation"

  changed_files:
    - "frontend/src/App.tsx"
    - "backend/app/main.py"
    - "tests/e2e/tasks.spec.ts"

  commands_run:
    - command: "npm test"
      status: "passed"
    - command: "pytest"
      status: "passed"
    - command: "npx playwright test"
      status: "passed"

  acceptance_criteria_claim:
    AC-001: "implemented"
    AC-002: "implemented"

  known_gaps:
    - "認証はスコープ外"

  risks:
    - "SQLite migration は MVP レベル"
```

### DEV-GEN-FR-004: Generator 禁止事項

Generator は以下を行ってはならない。

```text
- frozen contract を変更する
- 評価基準を緩める
- stub 実装で完了扱いにする
- local state のみで永続化したふりをする
- red lines に違反する
- 指摘修正時にスコープを広げる
- 評価を自分だけで PASS 判定する
```

### DEV-GEN-FR-005: Claude Code adapter

Claude Code は headless mode を使わない。

adapter は以下を行う。

```text
- worktree を作成する
- Claude Code 用 prompt file を生成する
- 人間または tmux 上の Claude Code session が読める形にする
- 必要に応じて Stop hook 用 evaluator script を配置する
```

Claude Code を UI 自動操作で無理やり制御してはならない。

### DEV-GEN-FR-006: Codex / Gemini adapter

Codex / Gemini は非対話実行が可能な場合、adapter 経由で呼び出せるようにする。

adapter は以下を抽象化する。

```text
- command
- working directory
- prompt file
- output file
- timeout
- sandbox mode
- model configuration
```

---

## 13. Evaluator 要件

### DEV-EVAL-FR-001: 入力

Evaluator は以下を入力として受け取る。

```text
- PR
- Issue Contract
- Generator handoff
- Git diff
- test results
- app runtime URL
```

### DEV-EVAL-FR-002: 評価手順

Evaluator は以下の順で評価する。

```text
1. Issue Contract を読む
2. PR diff を読む
3. clean worktree に checkout する
4. install / build を行う
5. unit tests を実行する
6. API tests を実行する
7. Playwright tests を実行する
8. 必要に応じて LLM reviewer を実行する
9. scorecard を作成する
10. PR review を投稿する
```

### DEV-EVAL-FR-003: Scorecard

Evaluator は以下の形式で scorecard を出力する。

```yaml
eval_scorecard:
  eval_run_id: "EV-PR45-ATTEMPT1"
  issue: 123
  pr: 45
  attempt: 1
  verdict: "request_changes"

  hard_gates:
    build: "pass"
    typecheck: "pass"
    unit_tests: "pass"
    api_tests: "pass"
    playwright: "fail"
    security_scan: "not_run"

  blocking_findings:
    - id: "F-001"
      criterion_id: "AC-001"
      severity: "blocker"
      expected: "リロード後も作成済みタスクが残る"
      observed: "リロード後に一覧が空になる"
      reproduction_steps:
        - "Open app"
        - "Create task 'Buy milk'"
        - "Reload page"
        - "Observe empty list"
      evidence:
        trace: "artifacts/eval/EV-PR45-ATTEMPT1/trace.zip"
        screenshot: "artifacts/eval/EV-PR45-ATTEMPT1/reload-empty.png"
      required_fix:
        - "Backend persistence を実装する"
        - "Frontend 初期化時に GET /tasks を呼ぶ"
        - "Playwright regression test を追加する"

  non_blocking_findings:
    - id: "F-002"
      severity: "minor"
      observed: "空状態メッセージがない"

  scores:
    functionality: 0.65
    code_quality: 0.82
    test_quality: 0.70
    ux: 0.75
    accessibility: 0.68

  next_action: "return_to_generator"
```

### DEV-EVAL-FR-004: 合否判定

以下の場合は必ず FAIL とする。

```text
- blocker finding が1件以上ある
- build が失敗する
- major acceptance criteria が未検証
- Playwright で主要フローが再現できない
- red line 違反がある
- contract が実装後に変更されている
```

スコア合計が高くても、blocker があれば PASS にしてはならない。

### DEV-EVAL-FR-005: PR review 投稿

Evaluator は PR に review を投稿する。

PASS の場合:

```text
gh pr review --approve
```

FAIL の場合:

```text
gh pr review --request-changes
```

加えて、Generator が機械的に読める repair block を PR comment に投稿する。

```yaml
repair_instruction:
  verdict: "request_changes"
  next_agent: "generator"
  repair_scope: "blocking_findings_only"
  max_attempts_remaining: 2
  blocking_findings:
    - criterion_id: "AC-001"
      required_fix:
        - "Backend persistence を実装する"
        - "Frontend 初期化時に GET /tasks を呼ぶ"
        - "Playwright regression test を追加する"
```

---

## 14. Repair Router 要件

### DEV-REPAIR-FR-001: 修正指示生成

Repair Router は Evaluator scorecard から Generator 向け修正指示を生成する。

```yaml
repair_prompt:
  issue: 123
  pr: 45
  attempt: 2
  rules:
    - "frozen contract を変更しない"
    - "blocking findings の修正に集中する"
    - "新機能を追加しない"
    - "修正後に regression test を追加する"
  findings:
    - "F-001"
```

### DEV-REPAIR-FR-002: 修正試行回数

修正ループには最大試行回数を設定する。

```yaml
repair_policy:
  max_attempts_per_pr: 3
  on_exceeded: "needs-human-review"
```

---

## 15. 評価ハーネス 要件

### 15.1 評価ハーネスの5大構成要素

評価ハーネスは以下の5要素を持つ。

```text
1. Eval Task Registry
2. Isolated Execution Environment
3. Graders
4. Evidence Store
5. Metrics / Dashboard / Feedback Loop
```

### EVAL-FR-001: Eval Task Registry

評価タスクを registry として保存する。

```yaml
eval_task:
  id: "EVAL-TASK-CRUD-001"
  source:
    type: "issue_contract"
    issue: 123
  feature_area: "task-crud"
  user_goal: "ユーザーがタスクを作成し、リロード後も確認できる"
  setup:
    seed_data: []
  steps:
    - "アプリを起動する"
    - "タスク 'Buy milk' を作成する"
    - "ページをリロードする"
  expected:
    - "タスク 'Buy milk' が一覧に残っている"
  graders:
    - "playwright_grader"
    - "api_state_grader"
  severity: "blocker"
```

### EVAL-FR-002: Isolated Execution Environment

評価は隔離環境で行う。

```text
- fresh git worktree
- clean install
- clean DB
- fixed seed data
- isolated browser context
- run-specific artifact directory
- previous run のキャッシュや状態を使わない
```

### EVAL-FR-003: Graders

Grader は3段階で構築する。

#### Stage 1: Deterministic hard gates

```text
- build
- typecheck
- lint
- unit tests
- API tests
- Playwright tests
- schema validation
- DB invariant checks
```

#### Stage 2: Rubric-based LLM graders

```text
- UX clarity
- product depth
- code maintainability
- architecture coherence
- error handling
- documentation quality
```

#### Stage 3: Composite / calibrated graders

複数 grader を組み合わせて総合スコアを作る。

ただし、blocker は別扱いとする。

```python
if blocker_count > 0:
    verdict = "fail"
else:
    verdict = weighted_score >= threshold
```

### EVAL-FR-004: Evidence Store

評価結果には証拠を保存する。

```text
- Playwright trace
- screenshots
- videos
- console logs
- network logs
- API responses
- DB snapshots
- test output
- PR diff
- scorecard
```

保存先例:

```text
artifacts/
  eval/
    EV-PR45-ATTEMPT1/
      scorecard.yaml
      trace.zip
      screenshots/
      logs/
      test-output.txt
```

### EVAL-FR-005: 非決定性の追跡

評価ハーネスは以下を追跡する。

```text
- pass@1
- pass@k
- pass^k
- repair success rate
- false pass rate
- false fail rate
- flaky eval rate
```

用途:

```text
pass@k:
  best-of-N generation の探索力評価に使う

pass^k:
  安定性・リリース信頼性評価に使う
```

記録単位:

```text
- agent
- model
- prompt version
- skill version
- issue type
- feature area
- grader version
```

---

## 16. Eval Curator 要件

### DEV-CURATOR-FR-001: 失敗の回帰ケース化

Eval Curator は、Evaluator の失敗や人間レビューで見つかった見逃しを eval task に昇格する。

例:

```text
PR が PASS したが、人間が触るとリロード後にデータが消えた
  ↓
false pass として記録
  ↓
reload persistence eval task を追加
```

### DEV-CURATOR-FR-002: Failure taxonomy

失敗を分類する。

```yaml
failure_taxonomy:
  planning_failure:
    - "Issue Contract が曖昧"
    - "acceptance criteria がテスト不能"
  generator_failure:
    - "stub 実装"
    - "scope creep"
    - "既存機能破壊"
  evaluator_failure:
    - "happy path のみ"
    - "false pass"
    - "false fail"
  tooling_failure:
    - "flaky test"
    - "environment setup failure"
  handoff_failure:
    - "必要な入力が不足"
    - "制約が伝わっていない"
```

---

## 17. ダッシュボード要件

### DASH-FR-001: Roadmap / Issue View

表示するもの。

```text
- Roadmap / Epic 進捗
- Issue 状態
- PR 状態
- evaluation status
- blocker count
```

### DASH-FR-002: Agent Performance View

表示するもの。

```text
- agent別 pass@1
- agent別 pass@k
- agent別 pass^k
- 平均 repair attempts
- 平均完了時間
- failure taxonomy
```

### DASH-FR-003: Eval Quality View

表示するもの。

```text
- false pass rate
- false fail rate
- flaky test rate
- grader disagreement
- eval coverage
```

### DASH-FR-004: Evidence Browser

表示するもの。

```text
- scorecard
- PR diff
- Playwright trace path
- screenshots
- logs
- repair instruction
```

MVP では静的HTML、Streamlit、またはローカルWeb UI のいずれでもよい。

---

## 18. 契約スキーマ

### 18.1 Artifact

```yaml
artifact:
  id: "ART-001"
  type: "issue_contract"
  title: "Task CRUD Issue Contract"
  path: "contracts/issue-123.yaml"
  created_by: "issue_planner"
  created_at: "2026-06-13T00:00:00+09:00"
  source_contract_id: "DC-DEV-001"
  confidence: "high"
  caveats: []
```

### 18.2 Handoff Contract

本実装では他部署連携は実行対象外だが、将来拡張のため schema を定義する。

```yaml
handoff_contract:
  id: "HF-DEV-TO-VIDEO-001"
  from_department: "development"
  to_department: "video"
  artifact_id: "DEV-RELEASE-NOTES-001"
  allowed_use:
    - "video_script_generation"
    - "social_post_drafting"
  caveats:
    - "リリース日は未確定"
  claims:
    - claim: "新機能はタスク共有を改善する"
      confidence: "medium"
      evidence: "release_notes"
      allowed_usage:
        - "機能説明として使ってよい"
      disallowed_usage:
        - "定量効果として主張してはいけない"
```

---

## 19. 他部署の扱い

本実装では以下の部署は構築しない。

```text
- Video Department
- Social Department
- Research Department
- Backoffice Department
```

ただし、例示として以下のような Department interface を持てるようにする。

```yaml
department_interface:
  department_id: "video"
  accepts:
    - "department_contract"
    - "handoff_contract"
  produces:
    - "artifact"
    - "evaluation_result"
    - "daily_report"
  status:
    - "requested"
    - "in_progress"
    - "ready_for_evaluation"
    - "completed"
    - "blocked"
```

他部署はサンプル contract のみ提供してよいが、worker agent、評価ハーネス、実行ロジックは実装しない。

---

## 20. セキュリティ・承認要件

### SEC-FR-001: 承認必須操作

以下は必ず人間承認を必要とする。

```text
- main branch への merge
- production deploy
- external publish
- SNS 投稿
- secret / token の変更
- 評価基準の緩和
- destructive command
- 新しい自律 agent の常駐起動
- 高コストな parallel run
```

### SEC-FR-002: Secret 管理

```text
- secret をログに出さない
- PR comment に secret を出さない
- artifact に secret を保存しない
- .env は必要最小限のみ読み込む
```

### SEC-FR-003: Agent 権限分離

Agent ごとに許可操作を分ける。

```yaml
permissions:
  hermes:
    can_create_contract: true
    can_route: true
    can_merge: false
    can_publish: false

  generator:
    can_edit_code: true
    can_create_pr: true
    can_merge: false

  evaluator:
    can_comment_pr: true
    can_request_changes: true
    can_edit_code: false

  release_manager:
    can_prepare_merge: true
    can_merge_requires_human_approval: true
```

---

## 21. 推奨ディレクトリ構成

```text
.harness/
  README.md

  hermes/
    HERMES.md
    intent_schema.json
    routing_rules.yaml
    prompts/
      intake.md
      progress_summary.md
      improvement_proposal.md

  departments/
    development/
      DEPARTMENT.md
      workflows/
        issue_to_pr.yaml
        pr_eval_repair.yaml
      agents/
        issue_planner.md
        generator.md
        evaluator.md
        repair_router.md
        eval_curator.md
      prompts/
        generator_prompt.md
        evaluator_prompt.md
        repair_prompt.md

    examples/
      video_department.example.yaml
      social_department.example.yaml
      research_department.example.yaml

  coordinator/
    coordinator.py
    github_labels.yaml
    state_machine.yaml

  adapters/
    codex_adapter.py
    gemini_adapter.py
    claude_interactive_adapter.py
    local_eval_adapter.py

  schemas/
    intake_contract.schema.json
    department_contract.schema.json
    issue_contract.schema.json
    handoff_contract.schema.json
    eval_scorecard.schema.json
    artifact.schema.json
    daily_report.schema.json
    improvement_proposal.schema.json

  eval/
    tasks/
    graders/
    runners/
    evidence/

  dashboard/
    app.py
    metrics.db

contracts/
  issues/

artifacts/
  eval/

runs/
  current/
```

---

## 22. CLI 要件

MVP では以下の CLI を提供する。

```bash
harness hermes intake "ログイン周りを改善したい"

harness dev create-issue-contract --intake IC-001

harness dev dispatch --issue 123 --agent claude

harness dev evaluate-pr --pr 45

harness dev repair --pr 45

harness dashboard
```

CLI は内部で GitHub CLI または GitHub API を利用してよい。

---

## 23. MVP 受け入れ条件

### MVP-AC-001: Hermes intake

人間が自然言語で依頼すると、Hermes が `IntakeContract` と `RoutingDecision` を生成できる。

### MVP-AC-002: 開発部署へのルーティング

開発系の依頼は Development Department に routing される。

### MVP-AC-003: Issue Contract 生成

開発依頼から、評価可能な Issue Contract が生成される。

### MVP-AC-004: Generator prompt 生成

Issue Contract から Generator 向け prompt が生成される。

Claude Code 用には interactive session で使える prompt file が生成される。

### MVP-AC-005: PR 評価

Evaluator は PR を checkout し、最低限以下を実行する。

```text
- build
- unit tests
- API tests
- Playwright smoke test
```

### MVP-AC-006: Scorecard 生成

Evaluator は `eval_scorecard.yaml` を生成する。

### MVP-AC-007: Repair loop

FAIL の場合、Repair Router が Generator 向け修正指示を生成する。

### MVP-AC-008: Metrics 保存

Eval run の結果が metrics DB に保存される。

### MVP-AC-009: Dashboard 表示

Dashboard で最低限以下が見える。

```text
- Issue 状態
- PR 状態
- eval verdict
- blocker findings
- repair attempts
```

### MVP-AC-010: 他部署は実装されない

Video / Social / Research などは sample schema / example のみに留め、実行 worker は作らない。

---

## 24. 実装フェーズ

### Phase 0: Skeleton

```text
- ディレクトリ構成作成
- schema 作成
- CLI skeleton
- GitHub label 定義
```

### Phase 1: Hermes MVP

```text
- Hermes intake
- intent classification
- routing decision
- development department への routing
```

### Phase 2: Development Department MVP

```text
- Issue Contract Planner
- Generator prompt generator
- Claude interactive adapter
- Codex / Gemini adapter placeholder
```

### Phase 3: Evaluation Harness MVP

```text
- PR checkout
- test runner
- Playwright runner
- scorecard generator
- evidence store
```

### Phase 4: Repair Loop

```text
- PR review parsing
- repair instruction generation
- retry attempt tracking
```

### Phase 5: Dashboard

```text
- metrics DB
- run history
- issue / PR / eval view
- blocker findings view
```

### Phase 6: Harness Improvement

```text
- daily report
- failure taxonomy
- improvement proposal
- skill / agent proposal schema
```

---

## 25. 重要な設計判断

本システムでは以下を守る。

```text
1. Hermes は入口であり、全能エージェントではない。

2. Coordinator は LLM ではなく通常コードで実装する。

3. 各部署は Hermes なしでも単体で動作可能にする。

4. 開発部署は GitHub Issue / PR を source of truth とする。

5. Evaluator は Generator から独立させる。

6. 合否は会話ではなく、scorecard と evidence に基づいて決める。

7. 修正ループでは frozen contract を変更しない。

8. 他部署は将来拡張の例に留め、今回の実装対象にはしない。

9. pass@k / pass^k / false pass / flaky rate を将来の評価改善の中核指標にする。

10. 日報と評価結果を、単なる記録ではなくハーネス改善データとして扱う。
```

---

## 26. 最終ゴール

本仕様の最終ゴールは以下である。

```text
人間が Hermes-agent に自然言語で依頼すると、
Hermes が意図を整理し、契約を作り、開発部署へルーティングする。

開発部署は Issue Contract に基づいて、
Generator が実装し、PR を作成し、Evaluator が評価し、
不合格なら修正ループを回し、合格ならリリース候補にする。

評価結果、失敗、修正履歴、改善提案はすべて蓄積され、
Dashboard と日報を通じて Hermes が人間に状況と次の改善候補を提示する。
```

この時点では、動画制作部署、SNS運用部署、調査部署は構築しない。
ただし、将来それらを追加できるよう、Department Contract、Handoff Contract、Artifact、Evaluation Contract の抽象は用意する。
