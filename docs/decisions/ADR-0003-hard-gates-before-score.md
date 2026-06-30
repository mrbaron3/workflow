# ADR-0003: hard gate を score より先に評価する

- 状態: 採択
- コンテキスト: evaluation（`graders/index.ts`）

## 文脈

PR の採点は複合スコア（functionality・codeQuality・testQuality・ux・a11y）と、blocker 級の必須条件の両方を持つ。
高スコアが致命的欠陥を覆い隠せてはならない。

## 決定

**blocker（hard gate）が1つでも落ちたら、複合スコアに関わらず `request_changes`。** 採点順は hard gate →
score。スコアで blocker を「平均して誤魔化す」ことを構造的に禁じる。

## 帰結

- ＋ 致命的欠陥を持つ PR が高スコアで通る false-pass を防ぐ（北極星: 証拠で評価・false-pass 率↓）。
- ＋ 修正ループ（[LANG-evaluation-009]）は blocker を最優先で潰す圧力になる。
- 関連: 証拠なき判定は出荷しない（`_system/evaluation/architecture.md` 横断ポリシー）。
