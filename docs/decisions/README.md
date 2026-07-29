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
| [ADR-0008](ADR-0008-github-issue-intake-and-entry-altitude.md) | 人間の着手要求の入口＝theme repo の GitHub Issue。planning-agent が Issue Contract-ready へ昇格・決定論 intake が store へ取り込む（PR ゲートの入口対称） | 採択・吸収・構造実装済み（CISO-07 bounded self-dogfood済み、通常外部target実証待ち） |
| [ADR-0009](ADR-0009-pr-native-autonomous-review-and-delivery.md) | PRのhead revisionを評価単位にし、複数観点レビュー→修正push→再レビュー→自動merge→次taskを同じ耐久ループで進める | 採択・吸収・構造実装済み（CISO-07 current-head修正・expected-head merge実証済み、通常継続turn待ち） |
| [ADR-0010](ADR-0010-webhook-ingress-and-multi-repository-control-plane.md) | Webhookを即時トリガー、pollをreconciliationとし、durable inbox・複数repo router・ローカル管理GUIを共通制御面にする | 採択・吸収・Go controlへ移行済み（CISO-07単一登録実証済み、複数repo常駐・forwarder実証待ち） |
| [ADR-0011](ADR-0011-standard-oci-image-and-container-runtime-adapter.md) | application imageを標準OCIとしてbuildし、Apple Container/macOS固有処理をcontainer runtime adapter境界だけへ隔離、preflightとpublish不変条件をfail-closedにする（AC-CISO-011） | 採択・吸収・構造実装済み（Apple Container 1.1 grounded smoke pass） |
| [ADR-0012](ADR-0012-external-designflow-provider.md) | UX/UI設計をDesignflowへ分離し、digest-boundな人間承認後にbackend capabilityを最終計画へ戻す | 採択・吸収・汎用consumer構造実装済み（ローカル標準intake headless E2E済み、remote/live black-box実証待ち） |
| [ADR-0013](ADR-0013-postgresql-control-plane-source-of-truth.md) | control-plane durable stateの唯一のSoTをPostgreSQLとし、transactional queue/lease、schema fail-closed、build/escape linkageを言語中立契約にする | 採択・吸収・構造実装済み（Apple Container/PostgreSQL grounded smoke pass） |
| [ADR-0014](ADR-0014-registration-driven-go-control.md) | PostgreSQL RegistrationからGo controlのmonitor/forwarder/routerを動的収束させ、approved Experience contractをAPI gateにする | 採択・吸収・構造実装済み（CISO-03） |
| [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md) | isolated runnerをPostgreSQL lease/Registration fence、private workspace、既存AgentOps gateの内側で実行する | 採択・吸収・構造実装済み（CISO-04） |
| [ADR-0016](ADR-0016-agentopsctl-lifecycle-authority.md) | 短命な`agentopsctl`だけをApple Container隔離基盤のlifecycle ownerとし、DB権威のdrain fence、復旧、補償、exact loopback publicationを行う | 採択・吸収・実装済み（CISO-06） |
| [ADR-0017](ADR-0017-private-repository-monitor-broker.md) | private repositoryのIssue/PR readをrunner credential境界内のtyped durable brokerへ閉じ、stale RegistrationとleaseをDBでfenceする | 採択・吸収・実装済み（CISO-07） |
| [ADR-0018](ADR-0018-surrogate-verifier-oracle-calibration.md) | 内部Panel全承認と独立外部検証の棄却をrevision単位の不透明な信号にし、次reviewerの検証被覆を強化する | 採択・吸収・構造実装済み（次revisionでのgrounded効果観測待ち） |
