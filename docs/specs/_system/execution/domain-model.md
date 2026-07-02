# ドメインモデル — execution コンテキスト

> 実装層（役割セッションのオーケストレーション）の戦術的 DDD。語彙は [ubiquitous-language.md](ubiquitous-language.md)
> （`LANG-execution-NNN`）と、参照する evaluation の語（`LANG-evaluation-NNN`）から**参照**し、再定義しない。
> 単一正本・追加のみ（`DOM-execution-NNN` は安定・renumber 禁止）。

## エンティティ／集約

- **DOM-execution-001 Execution Layer** — 同一性: store につき単一の概念的な層; 所有: 入力＝Issue Queue（`LANG-execution-002`）のみ。上流（planning/authoring/design）の生成過程に依存しない。集約ルート: yes（層の境界＝ACL）。
- **DOM-execution-002 Session** — 同一性: `(issueId, sampleIndex, role)`; 所有: worktree・branch・sentinel・scoped-context（`LANG-execution-005`/`006`/`007`/`008`）。**揮発**——durable な足跡は既存の PR/Issue status に写る（新規の永続実体を作らない）。集約ルート: yes（ライフサイクル: spawn → run → sentinel → graded）。
- **DOM-execution-003 Evaluator Panel** — 同一性: 1 sample（`LANG-evaluation-003`）につき 1 パネル; 所有: Perspective（`LANG-execution-010`）ごとの独立 Evaluator セッション（`LANG-evaluation-005`）の集合。各 Perspective は独立に Verdict（`LANG-evaluation-007`）を出す。集約ルート: yes。

## 関係と境界

- Execution Layer は Issue Queue から issue を1つずつ取り、issue ごとに best-of-N の Session 群を起こす（`LANG-evaluation-003` sample）。
- Session はちょうど 1 つの Worktree を持ち、そこで実ファイルを編集し、完了時に 1 つの Sentinel を残す。
- Evaluator Panel は 1 sample の PR（`LANG-evaluation-004`）を Perspective 数だけの Evaluator セッションで採点し、その Verdict を集約する。
- **evaluation コンテキストとの境界**: execution は evaluation の Generator/Evaluator/grader（`LANG-evaluation-002`/`005`・`ARCH-evaluation-002`/`003`）を **role-scoped セッションとして*駆動*する**だけで、採点の意味論（hard-gate→score・Scorecard・Verdict）は evaluation が所有し、execution は再定義しない。会話は Shared Kernel（`domain/schema.ts`・`store`）を通す。
- **planning/design コンテキストとの境界**: 入力は署名 spec から分解された Issue（`DOM-planning-003` の下流）。queue が腐敗防止層で、execution は「issue がどう作られたか」を知らない。

## ドメイン不変条件・イベント・状態

- **DOM-execution-004 観点集約の不変条件** — sample の最終 Verdict は観点 Verdict の集約: いずれかの blocker 観点が `request_changes` なら sample も `request_changes`（`ARCH-evaluation-011` hard-gate-before-score の観点版。スコア平均で blocker を相殺しない）。
- **DOM-execution-005 Sentinel ハンドオフの不変条件** — Orchestrator は Sentinel（`LANG-execution-008`）が現れるまで grade しない。セッションの完了は Sentinel でのみ確定する（tmux プロセスの生存は状態ではない・`ARCH-evaluation-008` と整合）。
- **DOM-execution-006 スコープガードの不変条件** — Orchestrator は `status==contract-drafted` **かつ** `assignedAgent==担当 AI`（`LANG-execution-012`）の issue のみを dispatch する。未指定／他人所有の issue は不変（触らない）。デフォルト非処理（opt-in）。
- **DOM-execution-007 審査ゲートの状態遷移** — パネル集約が approve でも自動 `released` にしない: `build-approved`（`LANG-evaluation-016`）→ `needs-human-review` → 人間承認 → `released`。自律は build-approved まで、release は人間の判断点（`LANG-execution-011`・北極星 §判断点）。
- **DOM-execution-008 決定論境界の不変条件** — poll / dispatch / grade / store 更新（seam の外側）は決定論コードが行い、非決定な実エージェントはセッション内（HOW の遂行）に閉じる。制御フローを LLM 判断へ委ねない（`ARCH-evaluation-010` の拡張）。
- **DOM-execution-009 liveness 昇格の不変条件** — セッションは**静かに終わらない**。正常完了は Sentinel（`DOM-execution-005`）で昇格し、stuck（`LANG-execution-014`）は store 状態（`needs-human-review`）＋ pane 証拠へ昇格する。stuck なセッションは静かに kill/timeout せず**生かしたまま**人間が引き継げる（`tmux attach`）。自動での続行注入はしない（人間の判断点へ渡す）。sentinel が正常完了の昇格なら、これは**異常停止の昇格**——揮発する tmux 状態を監査可能な store 状態へ上げる（`ARCH-evaluation-008`）。
