# 決定記録（ADR）

> アーキテクチャ上の**判断**の append-only ログ（DOC_TAXONOMY §ID 体系・`ADR-NNNN`）。各 ADR は文脈・決定・
> 帰結を残す。決定は削除せず、覆すときは新 ADR で **supersede** する。system 層（`_system/<ctx>/`）が「何で
> あるか」を、ここが「なぜそう決めたか」を持つ。旧 `docs/ARCHITECTURE.md` の "Key design choices" / "Why JSON"
> はここへ移設。
>
> **吸収の強制（2026-07-05 決定）**: ADR は **delta（決定という事件）**、system ビューは **state（現在の真実）**。
> 採択した ADR の premises は必ず `_system/<ctx>/` ビューへ **additive に吸収**し、ADR 末尾に **実装先 id**
> （`ARCH/DOM/DATA/LANG-<CTX>-NNN`）を列挙する。ビュー側の各 id は根拠として ADR を逆参照する。
> 吸収されるまで ADR は「採択（未吸収）」であり、実装の契約は常にビューの id（ADR を直接実装しない）。
> この規約の機械検証（採択 ADR ⇔ 実装先 id 実在）は将来 `scripts/check-*` へ落とす（決定論はコードへ）。

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [ADR-0001](ADR-0001-json-store-as-source-of-truth.md) | 状態の単一正本は JSON ストア（SQLite/GitHub でなく） | 採択 |
| [ADR-0002](ADR-0002-zod-contracts-published-language.md) | cross-agent 成果物は zod 契約で検証する（Published Language） | 採択 |
| [ADR-0003](ADR-0003-hard-gates-before-score.md) | hard gate を score より先に評価する | 採択 |
| [ADR-0004](ADR-0004-determinism-and-pluggable-backend.md) | 決定論を構成で保証し、agent backend を差し替え可能にする | 採択 |
| [ADR-0005](ADR-0005-execution-layer-tmux-orchestration.md) | 実装層は issue queue を入力とする独立層とし、tmux で role-scoped セッションをオーケストレーションする | 採択 |
| [ADR-0006](ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) | evaluator パネルは観点ごとの独立セッションで fan-out し決定論コードが集約する。審査ゲート UI は GitHub PR | 採択 |
| [ADR-0007](ADR-0007-improvement-loop-wiring.md) | ③改善ループの配線: 提案は Analyst・WHAT 確定は人間の adopt・実行は既存 drive loop、self-hosting は env-gate 受け入れテスト | 採択（未吸収） |
| [ADR-0008](ADR-0008-github-issue-intake-and-entry-altitude.md) | 人間の着手要求の入口＝theme repo の GitHub Issue。planning-agent が Issue Contract-ready へ昇格・決定論 intake が store へ取り込む（PR ゲートの入口対称） | 採択・吸収済み（実remote実証待ち） |
| [ADR-0009](ADR-0009-pr-native-autonomous-review-and-delivery.md) | PRのhead revisionを評価単位にし、複数観点レビュー→修正push→再レビュー→自動merge→次taskを同じ耐久ループで進める | 採択・吸収・構造実装済み（grounded run待ち） |
| [ADR-0010](ADR-0010-webhook-ingress-and-multi-repository-control-plane.md) | Webhookを即時トリガー、pollをreconciliationとし、durable inbox・複数repo router・ローカル管理GUIを共通制御面にする | 採択・吸収・構造実装済み（grounded run待ち） |
