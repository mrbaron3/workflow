# Issue-scoped acceptance collection 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「build の採点で活性化される先置き受け入れガードは、
> **駆動中 issue に帰属するものだけ**」という観測可能な性質。活性化の伝達手段（環境変数の名前・
> 宣言 helper の形・コマンド合成の場所）は実装の裁量。ただし**帰属は guard 著述時の明示宣言**であり、
> ファイル名やタイトル文字列からの推測で決めない（レッドライン）。
>
> **現状（D3 ギャップ・⑬ grounded 発見）**: 先置きガードは単一の全活性フラグ
> （`ACCEPT_HARNESS=1`）で一斉に RED 活性化し、hard gate は suite 全体の成否を見る。
> per-criterion 突合は既に issue-scoped だが、**suite 全体 green の要求**が最初に駆動された
> issue へ他 issue の payload 実装を強制した（ISSUE-0019 が 0020/0021 を背負った omnibus）。
> 複数 issue 分解の意味（PR サイズ・帰属・並行の意義）がこの構造で崩れる。
> 正本: docs/NORTH_STAR_PLAN.md §2 横断 D3。
>
> **参照する固定制約**: `ARCH-evaluation-003`／`ARCH-evaluation-011`（hard-gate-before-score —
> gate の厳格さ自体は不変）・`ARCH-execution-016`（gate-before-panel）・`ARCH-execution-015`
> （never-silent — 非活性は沈黙させない）。dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Issue-scoped acceptance collection
- outcome（価値・なぜ今）: 受け入れゲートの収集が駆動中 issue に scoped される: 複数 issue のグレーダを同時に先置きしても、各 build は自 issue の先置きガード（＋既存 baseline suite）だけを green にすれば通り、他 in-flight issue の先置きガードは活性化されない（⑬の grounded 失敗＝ISSUE-0019 が 0020/0021 の payload を背負った omnibus 実装強制の封じ込め）。活性化しなかったガードは理由付きで可視（never-silent）。released 済みガードの恒久昇格と全活性の baseline 検証は不変。
- 計画の木リンク: feature=FEAT-009 epic=EPIC-04

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| SCOPED-A | 駆動 issue 単位の先置きガード活性化（omnibus 封じ） | 高 |
| SCOPED-B | 非活性ガードの理由付き可視化（never-silent） | 高 |
| SCOPED-C | 全活性 baseline と恒久昇格の不変（後方互換） | 高 |

## SCOPED-A 駆動 issue 単位の先置きガード活性化

**ユーザーストーリー**

- 誰が: 進行管理役（採点）と各 issue の generator
- 何を: 複数 issue の先置きガードが同時に存在しても、各 build の採点では自 issue に帰属する
  ガードだけが RED 対象になる
- なぜ: suite 全体 green の要求は、最初に駆動された issue に他 issue の実装まで背負わせる
  （omnibus）。分解した issue の帰属と PR サイズ、並行 drive の意義を守るには、
  受け入れ収集そのものが issue に scoped されている必要がある

**事前条件**

- 先置きガードは著述時に帰属 issue を明示宣言している（ハーネス所有・operator が
  グレーダ先置き時に付与する規約 — ADR-0007 I3 の拡張）
- per-criterion 突合（`ISSUE-XXXX/AC-N` scoped タグ）は既存のまま（本 spec は収集層のみを扱う）

**受け入れ基準**

- **[AC-SCOPED-001] 正常系: 駆動 issue の build は自 issue のガード差分だけで hard gate を通過する**
  - Given 2+ issue 分の先置きガード（未 released・帰属宣言済み）が存在し、issue X の build が
    自 issue のガードと既存 baseline suite だけを green にしている
  - When issue X の build を採点する
  - Then unit_tests の hard gate は pass する。他 in-flight issue に帰属する先置きガードは
    実行されず、その RED が X の採点結果に現れない。並行 drive 下でも各 build の採点は
    独立に自 issue のガードだけを活性化する

- **[AC-SCOPED-002] 境界: 同一ファイルに複数 issue のガードが同居しても、活性化は帰属単位で効く**
  - Given 1 つの先置きガードファイルに issue X と issue Y に帰属するガード群が同居している
    （現行実例: 0019/0020 が同一ファイル）
  - When issue X を駆動して採点する
  - Then X に帰属するガードだけが実行され、Y に帰属するガードは非活性のまま
    （ファイル単位の全活性・全非活性にならない）

## SCOPED-B 非活性ガードの理由付き可視化

**ユーザーストーリー**

- 誰が: 人間（ゲート判断・監査）
- 何を: 採点で活性化されなかった先置きガードがどれか・なぜかを、採点の事実として見る
- なぜ: 選択的収集は「検証していないもの」を生む。それが沈黙すると false-pass の新しい
  入口になる（never-silent — 実行できない検証は理由付きで報告する）

**受け入れ基準**

- **[AC-SCOPED-003] 可視性: 活性化されなかった先置きガードは理由付きで採点結果に列挙される**
  - Given 駆動 issue X の採点で、他 in-flight issue に帰属する先置きガードが非活性のまま残った
  - When 採点結果（store に残る build の事実）を見る
  - Then 非活性のガードの帰属 issue と理由（駆動外 issue のため非活性）が列挙され、
    沈黙スキップにならない。非活性ガードが存在しない採点では列挙は現れない

## SCOPED-C 全活性 baseline と恒久昇格の不変

**ユーザーストーリー**

- 誰が: 進行管理役（baseline RED 検査・回帰実行）・人間（独立検証）
- 何を: 全活性の一括検証と、released 後の恒久ガードの無条件実行を従来どおり使う
- なぜ: グレーダ先置き時の baseline RED/GREEN 検査と、released 後の回帰保護
  （「同じ失敗を二度繰り返さない」）は scoping の犠牲にできない

**受け入れ基準**

- **[AC-SCOPED-004] 後方互換: 全活性指定と恒久昇格済みガードの挙動は不変**
  - Given 恒久昇格済み（活性化条件なし）のガードと、帰属宣言付きの先置きガードが混在する suite
  - When (a) 全活性指定（従来の `ACCEPT_HARNESS=1` 相当）で suite を実行する／
    (b) 駆動 issue を scoped 指定して採点する
  - Then (a) では全先置きガードが従来どおり一斉に活性化する（baseline RED 検査・
    回帰実行の捕捉コマンドの挙動不変）。(b) でも恒久昇格済みガードは駆動 issue に
    関わらず常に実行される（scoping の対象は未 released の先置きガードのみ）

**非機能要件**

- 決定論: 活性化選択・非活性報告の分岐は、実セッション/実 tmux なしに検証できる。
- 互換性: additive — 先置きガードが存在しない target・単一 issue の drive では
  従来と同一の採点結果になる。
- 可観測性: 非活性の事実は store に残る採点結果の一部である（「ログにだけある状態」を
  作らない — ADR-0001）。

**完了条件**

- 自動テスト: scoped 活性化（同一ファイル同居の帰属分離を含む）／非活性の理由付き列挙／
  全活性・恒久昇格の不変 各 1 以上。
- 運用観測（released 後・grader 対象外）: 2+ issue のグレーダ同時先置きで、各 build が
  自 issue の AC 差分だけを実装して released になる（D3 完了条件 — 観測後に
  NORTH_STAR_PLAN 台帳を更新する）。

## レッドライン

> 実装が絶対にしてはならないこと。

- 合格基準を緩めない: scoping が免除するのは**他 in-flight issue の先置きガードだけ**。
  自 issue のガードと既存 baseline suite の green 要件は従来どおり（hard-gate-before-score —
  `ARCH-evaluation-011` — の厳格さは不変条件）。
- 恒久昇格済みガードを scoping の対象にしない（released 後の回帰保護は無条件・
  「同じ失敗を二度繰り返さない」を弱めない）。
- 帰属を推測しない: ファイル名・テスト名文字列からの暗黙帰属で活性化を決めない
  （帰属は guard 著述時の明示宣言のみ）。
- 非活性を沈黙 skip にしない（理由なき skip の導入禁止 — `ARCH-execution-015`）。
- `test/acceptance-harness/**` に generator が触れない（ハーネス所有の独立採点者・
  protectedPaths — 従来どおり）。
- 全活性（`ACCEPT_HARNESS=1` 相当）の意味を変えない・消さない。
- 合格基準（既存テスト）を弱体化しない。
