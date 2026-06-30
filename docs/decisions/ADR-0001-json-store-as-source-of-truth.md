# ADR-0001: 状態の単一正本は JSON ストア

- 状態: 採択
- コンテキスト: evaluation（Shared Kernel: `store`）

## 文脈

ハーネスの状態（Issue / PR / EvalRun / SpecState …）はどこに住むべきか。北極星は「状態が tmux や人の頭でなく
証拠に住み、resume・監査できる」ことを要求する。選択肢: JSON ファイル / 埋め込み DB（SQLite）/ GitHub
（Issues・PR を正本に）。

## 決定

**単一の JSON ストア（`.harness/db.json`）を source of truth とする。** プロセスがどの段で死んでも、次の
`run`/`status`/`dashboard` が同じ JSON を読んで継続する。SQLite と GitHub backend は**拡張 seam**として
`store/store.ts` の差し替えで後から入れられるが、MVP の正本は JSON。

## 帰結

- ＋ ゼロインフラ・PR で差分が見える・完全に resume/監査可能（北極星に直結）。
- ＋ Eval DB が1ファイルなので、回帰・pass@k 算出・dashboard が同じソースから決定論的に再生成できる。
- − 大規模では JSON の読み書きがボトルネックになりうる → GitHub/SQLite backend（seam）で対応（ROADMAP v2）。
- データの形は zod 契約（[ADR-0002](ADR-0002-zod-contracts-published-language.md)）で検証される。
