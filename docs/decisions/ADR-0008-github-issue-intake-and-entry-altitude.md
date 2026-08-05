# ADR-0008: 人間の開発着手要求の入口は theme repo の GitHub Issue とし、planning-agent が Issue Contract-ready まで昇格させ、決定論の intake アダプタが store へ取り込む

- 状態: 採択・吸収済み（2026-07-14。`_system/intake`、EPIC-08、`apps/agentops/src/intake/`へ実装。実remote grounded runは未実施）
- コンテキスト: intake（新規 seam — 人間の着手要求 → store issue queue の源泉）。execution（drive loop）・planning/authoring（昇格ステップ）を**参照**し再定義しない。
- 関連:
  - [ADR-0006](ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md)（GitHub PR ＝**出口**ゲート。本 ADR は同じ theme repo の GitHub を**入口**へ対称化する — issue で着手、PR で審査）
  - [ADR-0005](ADR-0005-execution-layer-tmux-orchestration.md)（execution は **issue queue を入力とする独立層**。本 ADR はその queue の"源泉"を定義するだけで、drive loop 自体は不変）
  - [ADR-0001](ADR-0001-json-store-as-source-of-truth.md)（store＝SoT。GitHub Issue は WHAT の**投影**であって真実でない — PR と同型に `externalRef`＋poll で対応付ける）
  - [ADR-0007](ADR-0007-improvement-loop-wiring.md)（adopt＝人間 WHAT 確定の判断点。GitHub Issue を立てる行為は adopt/assign と同じ「HOW を AI に委任する判断点」の GitHub 投影）

## 文脈

⑯ の設計対話（ビジョン言語化）で人間が目標像を再言語化した — 「**GitHub に issue を立てたら AI が拾って PR が作られ、検証を経てリリースされる**」。これは [NORTH_STAR.md](../NORTH_STAR.md) の究極目標「人間は WHAT のみ」の**入口の具体化**であり、新しい星ではない。

言語化が炙り出した現状との差分:

1. **入口が未成立**。パイプラインの大半（planning=`to-system-design`、Issue Contract=ready-when-parses、7観点パネル=`apps/agentops/src/pipeline/panel.ts`、専用コンテキスト=ADR-0005 tmux セッション＋`scoped-context.ts`、決定論オーケストレータ、pass@k/pass^k 評価）は**既に実装済み**。しかし人間の着手要求を受ける**入口**が無い。GitHub 連携は ADR-0006 で**出口（PR ゲート）にしか繋がっていない**。内部 poll（`guard.ts`）は `status==contract-drafted && assignedAgent==generator` の **store issue** を見るが、**GitHub Issues は見ない**。
2. **入口の altitude が二択だった**。人間の入口を (a) **粗い GitHub Issue を直接立てる**（planning-agent が enrich）とするか、(b) 現行どおり **spec（WHAT）を著して harness が Issue Contract へ分解**する（GitHub Issue は harness の出力）か。この二択は入口の高さが違い、GitHub 連携の向き（出口のみ vs 入口+出口）を左右する。
3. **§5 の repo 関係モデルとの接続**。[NORTH_STAR_PLAN.md](../NORTH_STAR_PLAN.md) §5（⑭確定）: workflow repo＝開発組織／theme repo＝開発対象、接点は `config.target` と **人間ゲート＝theme repo の GitHub PR**。本 ADR は同じ接点に**入口（GitHub Issue）**を足すだけで、モデルを変えない。

⑯ 設計対話で人間が確定: **入口の altitude ＝ (a) GitHub Issue 直接・監視**。

## 決定

### 入口の altitude と源泉

- **I1 入口＝theme repo の GitHub Issue（粗い WHAT）**。人間は theme repo に issue を立てる＝それが開発着手の入口。issue が「拾ってよい（ready）」状態であることが watcher の起動 signal。人間の関与は「issue を立てる／ready にする」という**判断点**に留まり、HOW には触れない（NORTH_STAR 非目標と整合）。
- **I2 planning-agent が Issue Contract-ready まで昇格させる**。粗い issue はそのままでは `IssueContract` schema を満たさない。専用コンテキストを持つ **planning-agent** が (i) アプリ全体の使用との**整合検証**、(ii) **ドメインモデルの浮き彫り**を行い、issue を **ready=parse（`IssueContract` が通る）**まで enrich する。これは新規著述ではなく、既存資産（`to-system-design` の `_system/<ctx>/` 参照・`apps/agentops/src/pipeline/contract-draft.ts` の contract 生成）を入口に配線する。enrich は**参照であって複製でない**（`dependsOnSystem` で system 要素を指す）。
- **I3 intake アダプタ（決定論）が GitHub Issue → store Issue へ写す**。GitHub Issue は WHAT の**投影**であって SoT でない（ADR-0001・PR と同型）。store の Issue と `externalRef`（additive）で対応付け、状態は **poll で検知**する（webhook を建てない — ADR-0006 G1 の PR ポーリングと同型）。取り込み・昇格・帰属はすべて**決定論コードとオーケストレーションの責務**で、LLM に編成を委ねない（ADR-0004・`DOM-execution-008`）。planning-agent の enrich だけが seam の内側（非決定）。
- **I4 取り込み後は既存 drive loop を不変で使う**。store に ready issue が入れば、以降は既存の `guard → driveIssueLive → panel → gate（ADR-0006）→ PR` がそのまま流れる。**新規は入口の配管（intake アダプタ＋watcher＋planning-agent 昇格ステップ）のみ**で、drive/panel/gate/評価/改善は一切変えない。
- **I5 上流チェーン入口（spec→spawn→assign）は撤去しない**。GitHub Issue 入口は **M4 の外部 target 用の主入口**。self-hosting（`config.target.repo='.'`）は当面 roadmap→spec 経路を残す（ハーネス自身の WHAT は roadmap.yaml が頂点・NORTH_STAR_PLAN §序）。config で入口を択一/併存にするかは spec 時に詰める（本 ADR は「theme repo の主入口＝GitHub Issue」だけを確定する）。

## 帰結

- ＋ 「**issue を立てたら自動で拾う**」が literal に成立する経路が定義される。人間の接点が theme repo の GitHub に一本化する（**issue で着手・PR で審査**）— ADR-0006 の出口と対称。
- ＋ 既存の drive/panel/gate/評価/改善が**不変**。追加は入口アダプタと planning-agent 昇格のみ＝変更面が小さく、既存の決定論境界・liveness・resume・SoT 不変条件をそのまま延長できる。
- ＋ §5 の repo 関係モデル（⑭）に additive。theme repo が「入口（issue）＋対象（code）＋ゲート（PR）」の三役を同一 repo で担う。
- − 新規依存: GitHub Issues API（intake アダプタ＋watcher poll）。ローカル使い捨て sandbox（remote 無し）では fallback が要る — channel-compass は remote 未設定なので**この経路の grounded 実走は remote 前提**（ADR-0006 G1 の github ゲート未実証と同じ制約）。
- − planning-agent の enrich 品質が新しい失敗面。粗い issue を**誤って**contract-ready にする（false-enrichment＝WHAT の捏造/歪曲）を評価軸で捉える必要がある（②評価の観測対象を「実装の false-pass」から「入口の false-enrichment」へ拡張）。
- − 依存 A5（モデル非依存）: ビジョンの「観点ごとに Codex/Claude」は panel が per-perspective に tool+model を選べて初めて入口経路上で成立する。A5 を最優先の構造ギャップへ昇格（NORTH_STAR_PLAN §2 ①）。
- − 依存 A7（UI/UX 著述ペルソナ）: UI を要する theme（channel-compass 等）では planning-agent の昇格が design token/system/component の著述まで及ぶ必要がある（NORTH_STAR_PLAN §2 ①）。

### spec/実装で確定した点

- **ready の semantics**: configurable label、既定`ready`。claim後は既定`agent-claimed`へ移す。
- **昇格の帰属**: `AgentInvocation(role=issue-planner)`＋`PlanningEnrichmentRecord`＋AC traceで耐久記録する。
- **self-hosting 入口**: I5どおりroadmap/spec経路を残し、`config.intake`未設定ならGitHub入口は無効。

## 実装先（吸収先 id・吸収規約 = decisions/README §吸収の強制）

I1-I5は次へ吸収済み。外部remote/providerを使うgrounded実走だけが残る:

| premise | 吸収先 | 実装 |
| --- | --- | --- |
| I1 入口＝GitHub Issue／I3 投影・poll・決定論取り込み | `LANG/DOM/ARCH/DATA-intake-*` | `github-issues.ts`＋`poll-intake`/`watch-github`、store-first claim |
| I2 planning-agent 昇格 | `ARCH-intake-006/007/010`＋agent-runtime | `planning-session.ts`＋`planning-enrichment.ts`、全AC trace gate |
| I4 drive loop 不変 | 既存 `ARCH-execution-001/002`（変更なし・参照のみ） | 既存 `guard.ts`／`loop.ts`（不変） |
| I5 入口の択一/併存 | `DATA-intake-004` | optional `config.intake`（既存上流経路と併存） |

requirements: EPIC-08 / FEAT-016..018（未署名）。実装: `apps/agentops/src/intake/`。恒久test: fake external/provider/driveを使う
縦断を含め全suite green。未完了: 実remote ready Issue→実provider panel→実GitHub PRのgrounded証拠。
