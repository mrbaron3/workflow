# 提案ライフサイクル（decline 器官と Analyst dedup 衛生）受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「adopt の対となる退役が監査可能な状態遷移として存在し、
> Analyst の在庫がルール同一性で循環する」という観測可能な性質。状態名の実装・CLI の形・
> rule id の命名は実装の裁量。
>
> **判断点の意味論（FEAT-004 spec の拡張）**: decline（Issue の close）と EvalTask の retire は
> adopt / assign / sign / decide / label に並ぶ**人間の判断点**であり、介入（HOW への関与）では
> ない — 介入語彙に入れない。また判断点なので**自動で発火させない**（Analyst やループが自動
> close/retire しない — 提案するのは自由、確定するのは人間）。
>
> **背景（⑧⑨の grounded 実証）**: `ISSUE_STATUSES` に closed が無く・EvalTask に retired が無く・
> `decide` は build 専用 — Analyst R1 自身が「close as investigated」と言うのに手段が無い
> （adopt/decline の非対称）。dedup はタイトル完全一致・全 status 横断（analyst.ts）のため、
> (a) 計器値がタイトルに焼き込まれ値が動くたび在庫が複製される（0004「0%」と 0008「33%」の併存、
> ⑨時点の次値は「20%」）、(b) 値が一致すると closed 後も**永久に再起票を沈黙させる**。
> ⑧の処遇判断（ISSUE-0002/0008/0010 退役・roman task 2 件退役）は器官の欠如により store 未適用。
>
> **参照する固定制約**: `ARCH-evaluation-007`（curator / analyst — 改善の閉路）／
> `ARCH-evaluation-008`（store＝source of truth）／`DOM-execution-006`（実行ガードは opt-in・
> 既定非処理）／[NORTH_STAR](../../NORTH_STAR.md)（判断点は消さない・eval レジストリの成長）。
> dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Proposal lifecycle: decline organ and analyst dedup hygiene
- outcome（価値・なぜ今）: adopt の対となる退役が監査可能な状態遷移として存在し（Issue の closed・EvalTask の retired・理由必須）、Analyst の dedup がルール同一性で効く（計器値の変動で在庫が複製されない）。⑧の処遇判断（NORTH_STAR_PLAN §4: ISSUE-0002/0008/0010・roman task 2 件）が store に適用され、R3 の再発火が止まる。
- 計画の木リンク: feature=FEAT-005 epic=EPIC-02

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| LIFE-A | Issue の decline 器官（理由必須・終端・監査可能） | 高 |
| LIFE-B | EvalTask の retire 器官（実行と分母から除外・捕捉の歴史は不変） | 高 |
| LIFE-C | Analyst dedup のルール同一性化（open 在庫に集約・終端は再起票を妨げない） | 高 |

## LIFE-A Issue の decline 器官

**ユーザーストーリー**

- 誰が: 人間（operator / WHAT 所有者）
- 何を: 採用しないと判断した提案・前提が消滅した planned 在庫を、理由付きの終端状態へ退役させる
- なぜ: 判断点（WHAT 確定）の半分が記録不能だと在庫が単調増加し、「未判断キュー」が
  ノイズ製造器になる（⑧で実証）。adopt と decline が対になって初めて在庫は循環する

**受け入れ基準**

- **[AC-LIFE-001] 正常系: 非終端 issue を理由付きで退役でき、退役は終端**
  - Given 非終端 status（planned / needs-human-review 等）の issue
  - When 理由を添えて decline する
  - Then issue は終端の退役状態になり、理由・時刻とともに store から監査できる。退役済み issue は
    実行ガード（pollable）に決して現れず、adopt / assign の対象にもならない。理由の欠落・
    存在しない issue・released（歴史）や退役済みへの再 decline は理由付きで loud に拒否される

## LIFE-B EvalTask の retire 器官

**ユーザーストーリー**

- 誰が: 人間（eval 所有者）
- 何を: ガード価値を失った回帰 task（揮発 sandbox 残骸等）を、理由付きで実行対象から退役させる
- なぜ: 検証不能な task が分母に残ると計器（executedRate / unverified）が恒久に汚れ、
  R3 が同じ在庫を提案し続ける。一方で捕捉の歴史（このACはかつて失敗した）は消してはならない

**受け入れ基準**

- **[AC-LIFE-002] 正常系: retired task は実行されず分母からも消えるが、沈黙も抹消もされない**
  - Given 回帰 registry に active な task と retired な task が混在する
  - When 回帰を実行し計器を算出する
  - Then retired task は実 grader で実行されず、retired であることが理由付きで報告に現れる
    （沈黙 skip ではない）。executedRate と unverified 数の分母/集計から retired は除外される。
    **captureRate は退役で変わらない**（捕捉の歴史は不変 — task レコードは削除されない）。
    理由の欠落・存在しない task は loud に拒否される

## LIFE-C Analyst dedup のルール同一性化

**ユーザーストーリー**

- 誰が: 進行管理役・人間（在庫の判断者）
- 何を: 同じ診断ルールの再発火は既存の open 在庫に集約し、退役・released 済みは再起票を妨げない
- なぜ: タイトル完全一致 dedup は「値が動くと複製・値が一致すると永久沈黙」の両側で壊れている。
  ルールが同一性を持てば在庫は「ルールごとに高々 1 つの open 提案」に収束し、
  終端後の再発火は新しい証拠として正しく立ち上がる

**受け入れ基準**

- **[AC-LIFE-003] 正常系: ルール再発火は open 在庫に集約され、終端は再起票を妨げない**
  - Given ある診断ルールから起票された open（非終端）の提案 issue が store に在る
  - When 同じルールが異なる計器値（タイトル文言が変わる）で再発火し、起票を実行する
  - Then 新しい issue は作られない（open 在庫への集約・複製ゼロ）。
    また Given その提案 issue が退役（closed）または released で終端している場合、
    When 同じルールが再発火すると、Then 新しい issue が起票できる（終端が再起票を
    永久沈黙させない — 失う情報ゼロ）

- **[AC-LIFE-004] R3 の前提から retired task が消える**
  - Given unbound / unverified な task が全て retired である registry
  - When Analyst が診断する
  - Then R3（registry hygiene）は発火しない（⑧の処遇判断適用後、R3 の再発火が止まる
    ことの機械的検証）。retired でない unbound / unverified が 1 つでも残れば従来どおり発火する

**非機能要件**

- 互換性: schema 変更は additive — 既存 store は無変換で parse でき、退役情報の無い issue/task は
  従来どおり active として扱われる。レコードの削除・破壊的 migration をしない。
- 決定論: 退役判定・dedup・R3 前提は store の内容だけから決まる（時刻や環境に依存しない）。
- 可観測性: closed issue / retired task は理由・時刻つきで store から列挙できる。

**完了条件**

- 自動テスト: decline の正常/拒否・retire の正常/拒否と分母除外・rule dedup の集約/非沈黙・
  R3 前提 各 1 以上。
- 運用観測（released 時・grader 対象外）: ⑧の処遇判断を store へ適用する —
  **順序は task→issue**（EVAL-TASK-ISSUE-0001-AC-1/2 を retire → ISSUE-0010 を close →
  ISSUE-0002 / ISSUE-0008 を close・各理由は NORTH_STAR_PLAN §4 の表）。適用後の
  `analyze`（report-only）で R3 が発火しないこと・executedRate 100% / unverified 0 を確認。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- decline / retire を自動化しない: Analyst・improveTick・ループのどこからも自動で close/retire を
  発火させない（判断点は人間のもの。提案と確定を分ける — ADR-0007 I1 と同じ境界）。
- decline / retire を介入語彙（INTERVENTION_KINDS）に入れない（判断点は介入ではない —
  FEAT-004 spec の意味論を破らない）。
- レコードを削除しない: closed issue・retired task は状態であって抹消ではない（監査・歴史の保全。
  captureRate の分母操作にも使わない）。
- released を close で上書きしない（歴史は不変）。
- 合格基準（既存テスト）を弱体化しない。
