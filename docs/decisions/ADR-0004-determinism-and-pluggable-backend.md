# ADR-0004: 決定論を構成で保証し、agent backend を差し替え可能にする

- 状態: 採択
- コンテキスト: evaluation（`agents/runner.ts`・`agents/mock.ts`・`util/hash.ts`）

## 文脈

pass@k / pass^k と回帰評価が信頼できるには、同一入力から同一結果が要る。一方、実運用では mock を実エージェント
（Claude Code / Codex / Gemini）へ差し替えたい。

## 決定

**（1）決定論を構成で保証する**: mock は全判定を文字列 seed から導き、`Math.random()` を使わない。同一入力 ⇒
同一 scorecard ⇒ 信頼できる pass@k/pass^k と再現可能なデモ。**（2）backend を pluggable にする**: パイプラインは
`AgentRunner` インタフェースにのみ依存し、`mock` と `cli`（実エージェント）は交換可能。

## 帰結

- ＋ 評価指標が再現可能・信頼可能（北極星: 改善を pass@k の時間推移で測れる）。
- ＋ 実エージェント/GitHub backend は seam の差し替えだけで入る（`config.generator` ＋ `agents/cli.ts`）。
- − 実エージェント運用の full-fidelity は対象リポジトリと実 grader（`npm test`/Playwright）の配線が要る（ROADMAP v2・MVP 境界）。
