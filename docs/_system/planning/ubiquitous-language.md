# ユビキタス言語 — planning コンテキスト

> planning コンテキストは**計画の木**を所有する：製品ゴールが、永続される roadmap → epic → feature へ
> どう分解され、各 feature が署名可能な spec へどう materialize されるか。本コンテキストの他の文書
> （domain / architecture / data）はすべてこの語彙で書く。追加のみ（`LANG-planning-NNN` は安定・renumber 禁止）。

| ID | 用語 | 意味（本コンテキスト全体で一貫して使う） |
| --- | --- | --- |
| LANG-planning-001 | Roadmap | 計画の木の根：製品ビジョン＋順序付き epic 群。ハーネスの store につき 1 つ。 |
| LANG-planning-002 | Epic | テーマ単位の粗い feature のまとまり。roadmap に属し、受け入れ基準は持たない。 |
| LANG-planning-003 | Feature | 計画の木の葉：**署名可能な 1 つの能力（capability）**。題目＋ outcome を持ち、ちょうど 1 つの epic に、（spawn 後は）ちょうど 1 つの spec にリンクする。 |
| LANG-planning-004 | Outcome | feature が生む価値・「なぜ今」。feature の唯一の必須の正当化であり、受け入れ基準とは別物・受け入れ基準ではない。 |
| LANG-planning-005 | 受け入れ基準（AC） | feature の、人間が著述・署名する WHAT。**署名された spec の中にのみ**存在する——roadmap・epic・feature には決して持たせない。 |
| LANG-planning-006 | Spec | 人間が著述し署名する正本（`spec.md` ＋ `acceptance.yaml`）。feature はちょうど 1 つの spec へ materialize される。 |
| LANG-planning-007 | Spec stub | spawn が産む空の著述可能 spec：意図のみで**まだ AC を含まない**。to-spec が AC を著述し、人間が署名する。 |
| LANG-planning-008 | 取込（Ingest） | planner が分解した roadmap を計画の木へ決定論的に永続すること。AC 入り・outcome 不在の入力は拒否し、失敗時は何も永続しない。 |
| LANG-planning-009 | Spawn | 各 in-plan な feature を、ちょうど 1 つの spec dir ＋追跡される（未署名の）spec state へ materialize すること。冪等かつ非破壊。 |
| LANG-planning-010 | 計画の木 | 永続されたグラフ「north-star/roadmap → epic → feature → spec」。「何を作る計画か」を署名可能な能力まで分解した、監査・resume 可能な状態。 |
| LANG-planning-011 | 署名 / ApprovedSpecRef | 人間の承認が産む、改竄検知可能な版固定記録：署名コミット＋ blob SHA＋ AC 単位の fingerprint。承認は人間の判断点。 |
| LANG-planning-012 | in-plan / descoped | feature は既定で in-plan。roadmap 源から外すと descoped へ反転する（**フラグ**であって削除ではない）ので、署名済みの証拠が残る。 |
| LANG-planning-013 | 再取込（Re-plan） | （変更された）roadmap を取り込み直すこと。additive かつ冪等：既存ノードと署名済み spec は保全し、真に新規の feature だけ追加する。 |
| LANG-planning-014 | トレース | 鎖「north-star/roadmap → epic → feature → spec → 署名された AC」を双方向に辿れること。評価・回帰・影響分析の母体。 |
| LANG-planning-015 | Theme | Epicを横断して分類する文字列軸。独立nodeや受け入れ基準の所有者ではなく、`apps/agentops/src/domain/schema.ts`の`Epic.theme`が実体である。agent promptに残る`Initiative`はThemeを指すlegacy aliasに限り、別階層が実装済みだと解釈しない。 |
