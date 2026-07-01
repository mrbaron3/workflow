# 決定記録（ADR）

> アーキテクチャ上の**判断**の append-only ログ（DOC_TAXONOMY §ID 体系・`ADR-NNNN`）。各 ADR は文脈・決定・
> 帰結を残す。決定は削除せず、覆すときは新 ADR で **supersede** する。system 層（`_system/<ctx>/`）が「何で
> あるか」を、ここが「なぜそう決めたか」を持つ。旧 `docs/ARCHITECTURE.md` の "Key design choices" / "Why JSON"
> はここへ移設。

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [ADR-0001](ADR-0001-json-store-as-source-of-truth.md) | 状態の単一正本は JSON ストア（SQLite/GitHub でなく） | 採択 |
| [ADR-0002](ADR-0002-zod-contracts-published-language.md) | cross-agent 成果物は zod 契約で検証する（Published Language） | 採択 |
| [ADR-0003](ADR-0003-hard-gates-before-score.md) | hard gate を score より先に評価する | 採択 |
| [ADR-0004](ADR-0004-determinism-and-pluggable-backend.md) | 決定論を構成で保証し、agent backend を差し替え可能にする | 採択 |
| [ADR-0005](ADR-0005-execution-layer-tmux-orchestration.md) | 実装層は issue queue を入力とする独立層とし、tmux で role-scoped セッションをオーケストレーションする | 採択 |
