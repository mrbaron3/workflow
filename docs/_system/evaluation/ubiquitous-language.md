# ユビキタス言語 — evaluation コンテキスト

> evaluation コンテキストは、Issue Contract を **生成 → 評価 → 修正 → リリース**し、証拠から指標・回帰・
> 改善を育てる中核ループを所有する。[context-map.md](../../context-map.md) の境界に従う。追加のみ
> （`LANG-evaluation-NNN` は安定）。

| ID | 用語 | 意味（evaluation コンテキスト内で一貫） |
| --- | --- | --- |
| LANG-evaluation-001 | Issue Contract | 1つの issue を実装可能**かつ**採点可能にしたもの: goal・story・scope・受け入れ基準・red lines。エージェントが実装する単位。 |
| LANG-evaluation-002 | Generator | Issue Contract から PR（branch + diff）を産むコーディングエージェント（mock / claude / codex / gemini）。 |
| LANG-evaluation-003 | Agent Work Unit / sample | 1 エージェントによる Issue Contract への 1 回の独立試行。best-of-N の 1 本。 |
| LANG-evaluation-004 | PR | Generator の出力（branch + diff）。1 sample につき 1 本。 |
| LANG-evaluation-005 | Evaluator | PR を独立に採点するエージェント。判定は証拠（evidence）から下す。 |
| LANG-evaluation-006 | Eval Run / Scorecard | Evaluator/grader の 1 実行＝構造化判定: hard gates・findings・scores・evidence・next action。Eval DB に保存。 |
| LANG-evaluation-007 | Verdict | 判定値: `approve` / `request_changes` / `needs_human`。 |
| LANG-evaluation-008 | Hard gate（score より先） | blocker 失敗はスコアに関わらず `request_changes`。スコアで「平均して誤魔化す」ことを許さない。 |
| LANG-evaluation-009 | Finding / Repair Loop | 不合格の指摘（criterion・severity・期待/観測・修正）。Generator が同じ PR を修正→再評価する閉路。 |
| LANG-evaluation-010 | Release | いずれかの sample が approve なら issue を `released`、無ければ `needs-human-review` へ escalate。 |
| LANG-evaluation-011 | pass@k / pass^k | k sample の **≥1 合格**（探索・k で上昇）／ **全合格**（一貫性・k で低下）。同一 issue で両方を測る。 |
| LANG-evaluation-012 | Evidence | 判定の根拠（trace・screenshot・logs・scorecard）。**証拠なき判定は出荷しない**。 |
| LANG-evaluation-013 | False pass / fail | grader が pass/fail と言うが人間が不同意。grader の質を測る（人間ラベルがあるとき）。 |
| LANG-evaluation-014 | Eval Task Registry | 実際の失敗から育てた、再実行可能な eval タスク（回帰）のデータセット。 |
| LANG-evaluation-015 | Curator / Harness Analyst | 失敗を回帰へ昇格する（Curator）／指標から `type:harness`・`type:eval` の改善 issue を計画の木へ戻す（Analyst）。 |
| LANG-evaluation-016 | build-approved | eval 合格（issue 側）。人間の WHAT 署名（`contract-approved`・authoring 側）とは別。 |
| LANG-evaluation-017 | Surrogate Verifier / Oracle Mismatch Signal | Perspective Panel は密な診断を返す代理検証器。全 required Perspective が approve したのに独立 required check／blocking review が棄却した revision を mismatch とし、失敗詳細を伏せた件数だけを次 reviewer の検証強化へ返す（ADR-0011）。外部信号を絶対的 ground truth とは呼ばない。 |
