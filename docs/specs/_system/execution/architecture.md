# アーキテクチャ — execution コンテキスト

> 実装層のオーケストレーションの public な形（seam/契約）のみ——内部実装は書かない。語は
> [ubiquitous-language.md](ubiquitous-language.md)（`LANG-execution-NNN`）・[domain-model.md](domain-model.md)
> （`DOM-execution-NNN`）と、参照する evaluation の seam（`ARCH-evaluation-NNN`）から参照する。
> 追加のみ（`ARCH-execution-NNN` は安定）。C4 文脈（コンテキスト関係）は [context-map.md](../../context-map.md)。

## モジュール境界と seam

- **ARCH-execution-001 orchestrator / watch** — 責務: Issue Queue を poll し issue を dispatch、セッションを fan-in、状態を store に確定する**決定論コード**（`DOM-execution-001`）。public な形: `watch(store, config): never`（poll ループ）が一発の run（`driveOnce`）を包む。落ちても store から resume（`ARCH-evaluation-008`）。**実装済み**（execution-loop spec）: `driveOnce`（`pollable` を drain→`driveIssueOnce`＝implement→panel→gate）／`watch`（run-once＋save＋poll cadence の薄い常駐）＝`src/pipeline/execution/loop.ts`。一巡後 issue は `contract-drafted` を離れるため再入は冪等、resume は store 状態のみから成る。generate は seam（mock／実 tmux backend）。
- **ARCH-execution-002 scoping guard** — 責務: dispatch 対象を opt-in に絞る（`DOM-execution-006`）。public な形: `pollable(store, config): Issue[]` ＝ `status==contract-drafted && assignedAgent==config.agent`。未指定／他人所有を除外。
- **ARCH-execution-003 session runner（tmux backend）** — 責務: role ＋ scoped-context ＋ worktree で 1 セッションを spawn し Sentinel を待つ（`DOM-execution-002`）。public な形: `runSession(role, ctx, worktree): SessionResult`。evaluation の AgentRunner（`ARCH-evaluation-002`）の tmux 実装で、backend は pluggable（自前 tmux／将来 Hermes・`LANG-execution-013`・ADR-0005）。**対話セッション（attach 可）であり `claude -p` headless を使わない。**
- **ARCH-execution-004 worktree isolation** — 責務: sample ごとに git worktree を用意/破棄する（`LANG-execution-007`）。public な形: `withWorktree(repo, branch, baseRef): path`。1 sample = 1 worktree、修正ループは同一 worktree を再利用。
- **ARCH-execution-005 sentinel protocol** — 責務: 完了印の契約を定める（`DOM-execution-005`）。public な形: worktree 直下の `.agentops/done.json`（agent が完了時に書く・orchestrator が polling で検知）。tmux 終了検知でなく sentinel を正とする（resume 容易）。
- **ARCH-execution-006 evaluator panel（fan-out / aggregate）** — 責務: Perspective ごとに Evaluator セッションを起こし、その Verdict を集約する（`DOM-execution-003`/`004`）。public な形: `runPanel(pr, perspectives): AggregateVerdict`。evaluation の evaluate/grader（`ARCH-evaluation-003`）を観点数だけ起動し、blocker 観点優先で束ねる。[ADR-0006](../../../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) が実装モデルを確定（E1 観点＝独立セッション・サブエージェント不可／E2 functionality は決定論 grader backend・残 6 観点のみ LLM セッション／E3 evaluator は read-only・出力は観点別 findings を zod 検証／E7 修復は観点横断で発生源観点タグ付き）。各観点は perspective タグ付き EvalRun を 1 件残し、resume は `(prId, attempt, perspective)` 粒度で冪等（`ARCH-execution-009`）。不正な観点出力は握り潰さず `needs-human-review` へ昇格（`ARCH-execution-015`）。
- **ARCH-execution-007 scoped-context assembler** — 責務: role に最小コンテキストを組む（`LANG-execution-006`）。public な形: `contextFor(role, issue, store): ScopedContext` ＝ 計画の木の `dependsOnSystem`（id 参照）から解決。汚染防止（`DOM-execution-001`）。
- **ARCH-execution-008 human review gate** — 責務: パネル approve 後・`released` 前に `needs-human-review` で停止し、人間承認で `released` へ進める（`DOM-execution-007`）。evaluation の release/escalate（`ARCH-evaluation-005`）に人間判断点を挿す。**ゲート UI は GitHub PR**（[ADR-0006](../../../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) G1-G3: push＋`gh pr create`→人間 merge で承認→poll で `released`。人間判定を `EvalRun.humanVerdict` へ記録＝false-pass 較正の収穫点）。store が SoT で GitHub PR は投影（`ARCH-execution-009`・ADR-0001）。**決定論コアは実装済み**（execution-loop spec）: `applyPanelVerdict`（approve→`build-approved`→`needs-human-review`・自動 released しない）／`recordHumanDecision`（承認→`released`＋humanVerdict 記録・冪等）＝`src/pipeline/execution/loop.ts`。承認の**入力元**（GitHub PR merge の検知）も実装済み＝`src/pipeline/execution/gate.ts`：`openGate`（approve→push＋`gh pr create`・`PR.externalRef` 記録）／`pollGate`（merge→approve／close→reject を `prStateToDecision` 経由で `recordHumanDecision` へ）。git/`gh` は `GhGateRunner` seam の裏（テストは fake runner で決定論）。既定 `config.gate.backend=store`（直ゲート・現状動作）で github は opt-in（`DATA-execution-005`）。watch 常駐（`ARCH-execution-001`）も `driveOnce`/`watch` として実装済み。
- **ARCH-execution-014 liveness モニタ / surfacing** — 責務: Sentinel 待ちと並行に pane を監視し、stuck（`LANG-execution-014`）を検知して顕在化する（`DOM-execution-009`）。public な形: `monitorLiveness(session, sentinelPath, { idleMs, hardCapMs, pollMs }): 'completed' | 'stuck' | 'timeout'`。判定: pane が `idleMs` 不変 ∧ 作業指標なし ∧ sentinel 無し → stuck；経過 > `hardCapMs` → timeout。stuck/timeout 時: store を `needs-human-review` にし pane スナップショットを evidence 保存、セッションは kill せず `tmux attach` を提示。**自動続行はしない。**

## 共有基盤（Shared Kernel への依存）

- **ARCH-execution-009 store＝source of truth** — セッション/worktree/sentinel は揮発、真実は Issue/PR/EvalRun（`ARCH-evaluation-008`）。orchestrator はどの段で死んでも次の poll が store から在庫を再構成して resume する。
- **ARCH-execution-010 契約＝zod（Published Language）** — セッション入出力（scoped-context・grade 結果）は store の出入りで `domain/schema.ts` により検証される（`ARCH-evaluation-009`）。

## 横断ポリシー

- **決定論の境界**: seam の**外側**（poll/dispatch/grade/store）は決定論コード、**内側**（HOW の遂行）だけが非決定な実エージェント（ADR-0005・`ARCH-evaluation-010` と整合）。mock も tmux も将来の Hermes も「同じ AgentRunner seam の実装違い」に落ちる。
- **headless 非目標**: セッションは対話（attach 可）で人間が審査・介入できる。fire-and-forget の `claude -p` は使わない。人間の判断点（承認/审查）を消さない。
- **最小コンテキスト**: 各セッションには role 最適な最小情報だけを渡す（木からの id 解決）。ロードマップ全体やコード全体は渡さない。

## アーキテクチャ不変条件

- **ARCH-execution-011** — Orchestrator は決定論コードであり、制御フロー（poll/dispatch/grade/store）を LLM 判断へ委ねない（`DOM-execution-008`）。
- **ARCH-execution-012** — セッションは queue の opt-in 指定（ai-managed）issue のみに生成される（scoping guard・`DOM-execution-006`）。
- **ARCH-execution-013** — sample は Sentinel の出現でのみ grade へ進む（`DOM-execution-005`）。tmux プロセス生存は grade 契機にしない。
- **ARCH-execution-015** — セッションは静かに終了しない: 正常完了は Sentinel、異常停止は liveness surfacing のいずれかで**必ず store に昇格**する（`DOM-execution-009`）。無言 timeout・無言 kill を禁ずる。
- **ARCH-execution-016 gate-before-panel** — パネルは hard gates 通過後にのみ招集される（ADR-0006 E4・`ARCH-evaluation-011` hard-gate-before-score の観点版）。blocking な hard gate が落ちる試行は観点採点に進まず（perspective タグ付き EvalRun を作らず）、gate findings のみを修復へ回す。決定論 grader（`ARCH-evaluation-003`）が gate を先に評価し、LLM 観点セッションにトークンを使わせない。
