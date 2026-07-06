# ADR-0005: 実装層は issue queue を入力とする独立層とし、tmux で role-scoped セッションをオーケストレーションする

- 状態: 採択（premises 確定・実装は後続スライス）
- コンテキスト: execution（新規・独立層）／境界は planning・authoring（上流）と evaluation（採点・改善）
- 関連: [ADR-0004](ADR-0004-determinism-and-pluggable-backend.md) の pluggable backend seam の「実 backend の中身」を定める。状態は [ADR-0001](ADR-0001-json-store-as-source-of-truth.md)（JSON store＝SoT）に載る。

## 文脈

北極星は「エージェント群が自律的に開発を行い、評価・改善する」を steer し、同時に **headless 運用を非目標**とし、
**人間の判断点（WHAT／承認／审查）を残す**（NORTH_STAR §非目標・§北極星）。ADR-0004 は backend を pluggable に
したが、現 `agents/cli.ts` は実 backend を `claude -p`（headless print mode）で呼ぶ前提で、これは非目標に抵触する。

理想の運用像は「1 本の長いセッションが全部やる」ではなく、**層状**である:

```text
人間: WHY/WHAT → 承認/署名（判断点）
  → 設計層: システムドキュメント（to-system-design）→ issue 分解（Issue Contract）
  → 【issue queue = store の contract-drafted】← 層の境界
  → 実装層（独立）: queue を poll し、issue ごとに実装を自律で進める
```

実装層は「issue がどう作られたか」を知らず、**queue を poll して各 issue を独立に処理する**。さらに実装層の内部も
1 本のセッションではなく、**ロールごとに最適コンテキストだけを渡した専用セッション**を立て、実装が終われば
**観点ごとのレビューセッション**へ渡す多エージェント構成である。

## 決定

**実装層を「contract-drafted issue queue を唯一の入力とする独立した処理層」として切り出し、その内部を coordinator が
role 単位の tmux 対話セッションを fan-out / fan-in するオーケストレーションとして実装する。** 確定した前提:

### 層と境界

- **L0 層境界＝issue queue**。実装層の入力は store の `contract-drafted` issue のみ。上流（authoring/planning/design）と
  下流（execution）を queue が腐敗防止層として分離する。実装層は上流の生成過程に依存しない（差し替え可能・逆も然り）。
- **L1 ポーリング駆動＝常駐 `watch` デーモン（決定論コード）**。オーケストレータは LLM でなく harness プロセス（`coordinator.ts`）。
  一発 `run`（今 actionable な issue を drain して exit）を poll ループで包んだ `watch` として常駐する。worker（generator/evaluator）
  **だけ**が tmux Claude セッション；poll／dispatch／grade／store 更新は決定論コードでトークンを使わない。落ちても store から resume。
- **L2 スコープガード（処理対象の限定・opt-in）**。watch の poll 述語は `status == contract-drafted` **かつ AI 処理が明示指定された
  issue のみ**。明示指定＝`assignedAgent` が daemon の担当エージェント（AI）に設定されていること（人間可視には `ai-managed` ラベル）。
  **未指定／他人が作った issue は決して触らない**（デフォルト非処理・opt-in）。所有者（「私」vs「他人」）の厳密な区別が要る段階で
  `owner`/`createdBy` を足す（現状は単一 store のため forward-ref、当面は assignment＝opt-in で代替）。

### 実行モデル

- **P0 実行基盤＝tmux 独立対話セッション**（`claude -p` headless ではない）。各セッションは attach 可＝人間が審査・介入できる。
- **P1 自律度＝半自律 HOW ＋ 結果への人間审查**。セッションは実装（HOW）を自走するが、各編集を人間は承認しない。
  人間の判断点は WHAT・承認・**結果の审查**。
- **P2 状態＝揮発セッション ＋ 永続 store**。真実は `.harness/db.json`（ADR-0001）。セッションが死んでも次の run が store から resume。

### オーケストレーション

- **P3 単位＝`role → session → scoped-context`**。coordinator が各ロールのセッションを spawn し fan-in する司令塔。
  ロールは既存 `AgentRole`／`agents/*.md` をそのまま実体化（新語彙を作らない）。
- **P4 evaluator＝観点パネル**。単一 verdict でなく、**観点ごとの独立セッション**が各自 verdict を出し、scorecard が集約する。
  観点セット＝grader 5次元（functionality／codeQuality／testQuality／ux／accessibility）＋ **security** ＋ **type-design** の **7観点**。
- **P5 context 組み立てを first-class に**。各セッションには role 最適な最小コンテキストだけを渡す。計画の木の
  `dependsOnSystem`（id 参照・never copied）から解決して組む＝セッション間のコンテキスト汚染を防ぐ。

### ハンドオフと判断点

- **Q1 完了検知＝sentinel**。セッションは完了時に worktree へ sentinel（例 `.agentops/done.json`）を書き、harness が polling で
  検知→grade。tmux 終了検知より頑健で resume と相性が良い。
- **Q2 headless seam を deprecate**。現 `cli.ts` の `claude -p` パスと README/`agents/*` の「headless print mode」記述は、
  本 ADR の tmux orchestration に置換（北極星の非目標との矛盾を解消）。`AgentRunner` seam 自体（ADR-0004）は存置。
  **実装済み**（`ARCH-execution-003` へ吸収済みの不変条件「`claude -p` を使わない」）: `src/agents/cli.ts`（`CliAgentRunner`）と `config.cli`／`AgentCliConfig` を削除、`makeRunner` は mock 以外で live tmux 経路（`runLoopLive`）へ誘導する throw に。`agents/generator.md`・README の JSON-block/headless 記述も実 tmux 実態（実テストで採点・sentinel で完了）に修正。
- **Q3 審査ゲート**。Evaluator パネルが approve した後、`released` の前に**人間審査ゲート**を挿す
  （`needs-human-review` → 人間承認で `released`）。`needs_human` verdict／`needs-human-review` status は schema に既存。

### 初期スライス

- まず **generator ＋ evaluator パネル**をセッション化（implement→review のコア）。plan/release/improve は当面 in-process。
  対象 repo は最初は使い捨て sandbox。grade は worktree に対する実 `tsc`/`vitest`（自己申告でなく実 exit code）。
- **執行バックエンドは自前 tmux で最小実装する**。[Hermes Agent](https://hermes-agent.org/ja/)（Nous Research・parallel
  sub-agents／内蔵 cron／sandbox 実行）は ADR-0004 の `AgentRunner` seam の**裏に置ける将来 backend**として forward-ref
  （今回は不採用）。採用時は curl install を避け、mise の http backend で URL＋checksum を固定してマニフェスト管理下に入れる
  （global 環境規約：`curl | sh` で管理外に入れない）。**orchestrator 自体を Hermes へ委ねる案は「決定論オーケストレータ」決定と
  衝突するため不採用**——Hermes を使うとしても seam の裏（執行の筋肉）に留め、poll/dispatch/grade/store は決定論コードが握る。

## 帰結

- ＋ 北極星に整合：自律は HOW まで、审查は人間の判断点、headless 非目標を回避。状態は store で resume・監査可能。
- ＋ 層の独立：実装層は上流の作り方に依存しない。上流（人間の WHAT）と下流（自律 HOW）を差し替え可能に保つ。
- ＋ 既存資産を活かす：`AgentRole`／`agents/*.md`／grader 次元／`dependsOnSystem`（id 参照）がそのまま土台。
- ＋ レビューが観点別に独立＝コンテキスト汚染を防ぎ、pr-review-toolkit 型の多観点審査を得る。
- − `coordinator` は「司令塔（fan-out/fan-in・poll）」へ、`evaluate` は「観点集約」へ拡張が要る（単一 evaluator 前提の変更）。
- − scorecard スキーマに観点別 findings/verdict の集約を足す。
- − インフラ：tmux 未導入 → brew（Brewfile 宣言）で入れる。実装フェーズの前提。
- − mock backend・決定論（ADR-0004）は据え置き。tmux 実 backend は非決定的なので、pass@k は実運用データで測る。
- 後続：execution コンテキストの `to-system-design`（language/domain/architecture/data）、`docs/context-map.md` に
  execution コンテキスト（所有：セッション・オーケストレーション・issue queue 消費）を追記、NORTH_STAR 下流トレースに反映。
