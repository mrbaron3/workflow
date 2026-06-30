# contract ドラフトの橋（署名 spec → 実行可能 issue）受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「署名済み spec から spawn された issue（planned・coversAcIds 付き・
> 契約未ドラフト）を、**署名された受け入れ基準を源に** Issue Contract を備えた実行可能状態へ進める、その
> 成果物の**観測可能な性質とゲート挙動**」。Issue Contract の**型**（productGoal/userStory/scope/AC/redLines の形）・
> status 機械の形・ドラフトの関数は本 spec に埋めない。それは **system 層（execution コンテキスト）data-model** が
> 定義する（未 seed のため **前方参照**）。
>
> **meta-feature の層分け**: 本機能はハーネス自身の機構（契約ドラフトの橋）を作る。形式（契約型/status）は
> system 層へ、**プロセスとゲート挙動は本 spec へ**。本 spec の AC が語るのは「何を源に契約を組み、何を進め、
> 何を拒み、何を保全するか」であって「Issue Contract とは何の型か」ではない。
>
> **参照する固定制約**: [NORTH_STAR](../../NORTH_STAR.md)（証拠で評価・改善／承認は人間の判断点）／
> 既存オーサリング層（署名＝ApprovedSpecRef・approvedAcIds が署名された AC 集合）／計画の木 system 層
> （`_system/planning/`：署名証拠 `DATA-planning-008`／`DOM-planning-005` を参照）。dependsOn は acceptance.yaml に置く。

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| CONTRACT-A | 契約ドラフト（spawn 済み issue を実行可能化・被覆を署名 AC へ忠実に） | 高 |
| CONTRACT-B | 整合・耐障害ゲート（未署名拒否・ドリフト拒否・冪等・spec スコープ） | 高 |

## CONTRACT-A 契約ドラフト

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）
- 何を: 署名済み spec から spawn された issue 群に Issue Contract を備えさせ、実行（Generate→Evaluate→…）に
  載る状態へ進める
- なぜ: spawn 直後の issue は「何の AC を負うか（coversAcIds）」は持つが、実行に必要な契約をまだ持たない。
  人間が署名した WHAT を**源**に契約を機械的に組み、人間の HOW 関与なく自律実行へ橋渡しするため（北極星: 自律）

**事前条件**

- 対象 spec は署名済みで、その issue 群が store に spawn 済み（planned・coversAcIds 付き・契約未ドラフト）。
- **Issue Contract の型・status 機械への前方参照**: 契約の形（productGoal/userStory/scope/受け入れ基準/redLines）と
  status 遷移の形は system 層（execution コンテキスト）data-model が定義する。未 seed のため seed 待ち（埋め込みで
  代替しない・レッドライン）。

**受け入れ基準**

- **[AC-CONTRACT-001] 正常系: spawn 済み issue が契約を得て実行可能になる**
  - Given 署名済み spec から spawn された、coversAcIds を持つ契約未ドラフトの issue 群がある
  - When その spec を指定して契約をドラフトする
  - Then 各 issue に有効な Issue Contract が付き、status が「契約ドラフト済み（実行対象）」へ前進する

- **[AC-CONTRACT-002] 正常系: 契約の受け入れ基準は coversAcIds と双方向一致し、署名 spec を源とする**
  - Given ある issue が、署名 spec の一部の AC を coversAcIds に持つ
  - When 契約をドラフトする
  - Then その契約が負う受け入れ基準は、coversAcIds が指す署名 AC 群と過不足なく一致する（どの AC も落とさず、
    coversAcIds に無い AC を足さない）。基準の内容は**署名された spec を源**とし、本機能は受け入れ基準を新規著述しない

## CONTRACT-B 整合・耐障害ゲート

**ユーザーストーリー**

- 誰が: 進行管理役（ハーネス）
- 何を: 契約ドラフトを、署名・署名 AC 集合・冪等・spec スコープの各ゲートで守る
- なぜ: 受け入れ基準は人間が署名した WHAT にのみ由来する。未署名や署名集合との不整合から契約を組むと、
  「証拠で評価」「承認は人間の判断点」という北極星原則が崩れる

**受け入れ基準**

- **[AC-CONTRACT-003] 異常系: 未署名 spec からは契約をドラフトしない**
  - Given 対象 spec が未署名である（署名記録が無い／approved が空）
  - When 契約ドラフトを試みる
  - Then 拒否され、どの issue の status も契約も変化しない（受け入れ基準は署名された WHAT にのみ由来する）

- **[AC-CONTRACT-004] 異常系: 署名 AC 集合に無い AC を負う issue を拒否する**
  - Given ある issue の coversAcIds が、現在の署名 AC 集合（approvedAcIds）に存在しない AC-ID を含む（spawn 後の
    再署名でドリフトした等）
  - When 契約ドラフトを試みる
  - Then 違反箇所を示して拒否し、当該 spec の issue 群の status・契約は一切変化しない（署名集合との整合を強制）

- **[AC-CONTRACT-005] 耐障害性: 再ドラフトは冪等で、進行済み issue を後退させない**
  - Given 一部の issue が既に契約ドラフト済み（またはそれ以降の status）である
  - When 再度同じ spec をドラフトする
  - Then 既にドラフト済みの issue の契約・status は変化せず（重複生成も後退も無く）、未ドラフトの issue だけが前進する

- **[AC-CONTRACT-006] 境界: 対象は指定した署名 spec の issue のみ**
  - Given 複数 spec 由来の issue が store に混在する
  - When ある spec を指定してドラフトする
  - Then specPath が一致する契約未ドラフトの issue だけが対象になり、他 spec の issue は status も契約も変化しない

**非機能要件**

- 決定論: 同一の（署名 spec・issue 群）入力からは同一の契約集合が得られる（再ドラフトで差分が出ない）。
- 可観測性: ドラフト・拒否は、進行管理役が状態だけから resume・監査できる形で残る。

**完了条件**

- 自動テスト: 正常（契約付与＋実行可能化・被覆双方向一致）／異常（未署名拒否・署名集合ドリフト拒否）／
  耐障害性（冪等再ドラフト・spec スコープ）を各 1 以上。
- データ確認: ドラフト後の永続状態（各 issue の status と契約の受け入れ基準集合）が期待どおりであること。

## レッドライン

> 実装が**絶対にしてはならない**こと。Generator への明示的禁止。

- Issue Contract の型・status 機械の形を本 spec.md に埋め込まない（system 層 data-model を前方参照する）。
- 受け入れ基準を本機能が新規著述・改変しない（署名された spec の AC のみを源とする）。
- 未署名 spec／署名 AC 集合に無い AC を負う issue から契約を組まない。
- 再ドラフトで、ドラフト済み・実行中・完了済みの issue の契約や status を上書き・後退させない。
- 指定 spec 以外の issue を変更しない。
