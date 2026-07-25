# ADR-0011: 代理検証器の承認と独立 oracle の棄却を、不透明な検証信号として次 revision へ返す

- 状態: 採択・吸収済み（2026-07-23。構造実装済み、grounded 不一致観測待ち）
- 参考:
  - [CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification](https://arxiv.org/abs/2604.01687)
  - [Agent Skills自動最適化の研究、中身はほぼ深層学習の訓練ループだった](https://zenn.dev/layerx/articles/9f25ec86a31730)

## 文脈

開放的なソフトウェア開発タスクには、出力全文の唯一の正解が無い。一方、正解が無いことは検証信号が
無いことを意味しない。本ハーネスには既に、Issue Contract、決定論 grader、独立 Perspective Panel、
GitHub required checks、外部 blocking review がある。しかし従来は、内部 Panel が全承認したのに外部検証が
棄却した事実を修復には使えても、**Panel 自身の見逃し**として次の reviewer へ返す明示的な経路が無かった。

同じ失敗詳細をそのまま reviewer に渡すと、その事例の答えへ過適合しやすい。逆に pass/fail すら返さなければ、
代理検証器は自分の false pass を知れない。

## 決定

### 密な代理検証と疎な独立信号を分ける

- Perspective Panel を、findings・原因・required fix を返す**代理検証器（surrogate verifier）**として扱う。
- GitHub required check failure と unresolved blocking review を、Panel から独立した疎な oracle 信号として扱う。
  これは「絶対的な正解」とは呼ばず、独立した反証可能な外部信号と位置づける。
- 次を同時に満たす PR Revision を **surrogate/oracle mismatch** とする。

```text
全 required Perspective が approve
AND (required check failure OR unresolved blocking review)
```

merge conflict、draft、head 変更、pending/missing evidence は運用状態であり、検証器の見逃しとして数えない。
内部 Perspective が既に `request_changes` を出した revision も、proxy が失敗を捕捉済みなので mismatch に数えない。

### 不一致は revision ごとに一票、不透明なまま返す

- 正本は既存の `RevisionGateSnapshot` とし、同じ revision を reconciliation が複数回観測しても一票とする。
- 次 revision の各 reviewer session へ渡すのは、同じ PR で過去に起きた mismatch の**件数だけ**とする。
  check 名、thread 本文、失敗箇所は渡さない。
- reviewer は件数を「自分たちの検証被覆が不足した」証拠として、仮定の反証、edge/adversarial case、
  実行可能または falsifiable な検査を増やす。隠れた check の内容を推測して最適化しない。
- mismatch は revision 履歴をまたいで残るため、繰り返す見逃しへの textual momentum として働く。

### 修復経路との情報境界

Generator の Repair Brief は従来どおり、required check 名や blocking thread 本文など、修復に必要な許可済み情報を
受け取れる。今回隔離するのは **reviewer の自己較正経路**である。したがって本決定は CoEvoSkills の厳密な
ground-truth 隔離を全面再現するものではなく、PR 開発で実用的な hybrid である。

## 帰結

- ＋ 唯一の正解がないタスクでも、独立検証との不一致から verifier 改善信号を作れる。
- ＋ 詳細を渡さないため、reviewer が特定 check や一つのレビューコメントへ直接過適合しにくい。
- ＋ 既存の PR Revision／gate snapshot を使うため、新しい可変状態や非決定論オーケストレーションを増やさない。
- − 現段階で共進化するのは reviewer の検証方針であり、決定論的な surrogate test suite 自体を永続・編集する
  ところまでは行わない。
- − required checks／外部 review 自体が弱ければ信号も弱い。mismatch が無いことは verifier の完全性を保証しない。
- − 論文は SkillsBench の hidden deterministic verifier を前提にする。本ハーネスの外部信号は同等の
  ground truth ではなく、転用可能な設計要素だけを採用したもの。

## system 層への吸収

| premise | 吸収先 |
| --- | --- |
| surrogate verifier と独立 oracle 信号の語彙 | `LANG-evaluation-017` |
| revision 単位の不一致検出・opaque feedback | `ARCH-evaluation-012` |
