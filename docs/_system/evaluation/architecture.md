# アーキテクチャ — evaluation コンテキスト

> 中核ループ（生成→評価→修正→リリース→指標/改善）の public な形（seam/契約）のみ——内部実装は書かない。
> 語は [ubiquitous-language.md](ubiquitous-language.md)（`LANG-evaluation-NNN`）を参照。旧 `docs/ARCHITECTURE.md`
> の Data flow ＋ Extension seams をここへ移設（C4 文脈＝コンテキスト関係は [context-map.md](../../context-map.md)）。
> 追加のみ（`ARCH-evaluation-NNN` は安定）。

## モジュール境界と seam

- **ARCH-evaluation-001 coordinator（オーケストレーション）** — 責務: 1 issue を best-of-N sample × 各 sample の修正ループで駆動する（`LANG-evaluation-003`）。public な形: `runIssue(store, config, runner, issue): RunIssueResult`／`runAll(store, …)` は `contract-drafted` の issue を走らせる。
- **ARCH-evaluation-002 AgentRunner（pluggable backend）** — 責務: Issue Contract から成果物を産む（`LANG-evaluation-002`）。public な形: `generate(contract, repairBrief?): BuildArtifact`。`mock`/`cli` は交換可能——ループは AgentRunner インタフェースにのみ依存する。
- **ARCH-evaluation-003 evaluate / grader（hard gate→score）** — 責務: PR を採点し EvalRun（scorecard）＋ evidence を産む（`LANG-evaluation-006`/`008`）。public な形: `evaluate(...): EvalRun`。blocker 失敗はスコアに関わらず `request_changes`。
- **ARCH-evaluation-004 repair（修正ルータ）** — 責務: findings から修正ブリーフを組み、同じ PR を再生成させる（`LANG-evaluation-009`）。public な形: `buildRepairBrief(run): RepairBrief`。
- **ARCH-evaluation-005 release / escalate** — 責務: いずれかの sample が approve なら `released`、無ければ `needs-human-review` へ escalate（`LANG-evaluation-010`）。
- **ARCH-evaluation-006 metrics** — 責務: EvalRun 群から pass@k/pass^k・area×失敗型 heatmap・cost を算出（`LANG-evaluation-011`）。
- **ARCH-evaluation-007 curator / analyst（改善の閉路）** — 責務: 失敗を回帰へ昇格（Curator）／指標から `type:harness`・`type:eval` 改善 issue を計画の木へ戻す（Analyst・`LANG-evaluation-015`）。evaluation → planning の Customer-Supplier フィードバック。

## 共有基盤（Shared Kernel への依存）

- **ARCH-evaluation-008 store＝source of truth** — 状態は Issue/PR/EvalRun に住み（tmux や人の頭でなく）、プロセスがどの段で死んでも次の `run`/`status`/`dashboard` が同じ JSON を読んで継続する。resume・監査可能（北極星）。
- **ARCH-evaluation-009 契約＝zod（Published Language）** — 全 cross-agent 成果物（contract・artifact・scorecard）は store の出入りで検証される。壊れた契約は黙って腐らず loud に落ちる。`apps/agentops/src/domain/schema.ts`（Shared Kernel）に依存。

## 横断ポリシー

- **決定論**: mock は全判定を文字列 seed から導く（`Math.random()` を使わない）。同一入力 ⇒ 同一 scorecard ⇒ 信頼できる pass@k/pass^k と再現可能なデモ。
- **証拠なき判定を出荷しない**: verdict は必ず evidence（trace/screenshot/logs/scorecard）を伴う（`LANG-evaluation-012`）。
- **id と時刻は seam で**: id は store（`nextId`）、時刻は注入 clock。

## アーキテクチャ不変条件

- **ARCH-evaluation-010** — パイプラインは AgentRunner インタフェースにのみ依存し、具体 backend（mock/cli）に依存しない（差し替え可能性を保つ）。
- **ARCH-evaluation-011** — hard gate は score の前に評価される: blocker が1つでも落ちれば `request_changes`（スコアで相殺できない）。
- **ARCH-evaluation-012 surrogate/oracle calibration** — PR Revision Gateで全 required Perspectiveがapproveした一方、独立required checkまたはblocking reviewが棄却したrevisionを代理検証器の見逃しとして導出する。同一revisionは一票とし、次revisionのreviewerへは過去mismatch件数だけを渡す。check名・thread本文は渡さず、reviewerは検証被覆を独立に強化する（ADR-0018、`apps/agentops/src/pipeline/verification-signal.ts`）。

## 拡張 seam（どこを変えれば伸ばせるか — 旧 ARCHITECTURE より移設）

| やりたいこと | 変える場所 |
| --- | --- |
| 実エージェントを走らせる | `apps/agentops/src/config.ts` ＋ `apps/agentops/src/agents/interactive-backend.ts`（＋対象リポジトリ） |
| 状態を GitHub で持つ | `apps/agentops/src/store/store.ts`（JSON read/save を Issues/PRs/labels API へ） |
| 実 grader を足す | `apps/agentops/src/graders/index.ts`（checkout に対し `npm test`/Playwright） |
| reviewer ペルソナを足す | 新 `apps/agentops/agents/*.md` ＋ `apps/agentops/src/pipeline/evaluate.ts` で起動 |
| 指標/パネルを足す | `apps/agentops/src/metrics/metrics.ts` ＋ `apps/agentops/src/dashboard/dashboard.ts` |
