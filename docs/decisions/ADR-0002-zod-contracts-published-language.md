# ADR-0002: cross-agent 成果物は zod 契約で検証する（Published Language）

- 状態: 採択
- コンテキスト: Shared Kernel（`domain/schema.ts`）— 全境界コンテキストが共有

## 文脈

複数のエージェント（Generator / Evaluator / …）と複数の境界コンテキストが、契約・成果物・scorecard を
受け渡す。境界を跨ぐ語彙が緩いと、壊れたデータが黙ってループを腐らせる。

## 決定

**全 cross-agent 成果物を zod スキーマ（`domain/schema.ts`）で、store の出入りごとに検証する。** この zod 契約が
コンテキスト間の **Published Language**（[context-map.md](../context-map.md)）＝各コンテキストは生の内部表現でなく
契約で会話する。壊れた契約・scorecard は黙って腐らず **loud に落ちる**。

## 帰結

- ＋ 境界が型で守られ、ドリフトが早期に loud に出る。
- ＋ 契約が単一正本なので、各コンテキストが重複定義しない（Shared Kernel）。
- ＋ データビューの構造化 SSOT もこの zod を参照する（テーブルへ二重化しない・[DOC_TAXONOMY](../_meta/DOC_TAXONOMY.md) §データビュー）。
- − スキーマ変更は全 consumer に波及する（Shared Kernel ゆえ）→ additive な進化を原則とする。
