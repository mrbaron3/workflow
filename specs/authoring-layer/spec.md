# M20 オーサリング層 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（成果物契約の
> 観測可能な挙動）** を著す source of truth（オーサリング SoT）。frontmatter は持たない（meta・署名は
> spec 状態オブジェクト ＝ ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「署名済み・ドリフト保護された受け入れ契約を人間＋AI で
> 産む協業プロセスの、**成果物の性質とゲート挙動**」である。契約の**スキーマ**（spec.md / acceptance.yaml
> の形式・AC-ID / GWT 規約・verification method の enum・join キー）は本 spec には埋めない。それは
> **system 層 data-model** が定義する（greenfield 初回は未整備のため **前方参照**・AUTH-FR-011）。slice 分解・
> PR サイズは設計層が三層設計として生成する（ADR-0004）。
>
> **自己参照の解消**: 著述層自身の spec が「spec 形式そのもの」を定義すると循環する。これを避けるため
> **スキーマは system 層へ、プロセス／ゲート挙動は本 spec へ**と層を分ける。本 spec の AC が語るのは
> 「ゲートが何を通し何を落とすか」「署名が何を永続するか」であって、「AC-ID とは何か」ではない。
>
> **参照する固定制約**: ADR-0001（authoring/execution 分離）, ADR-0003（contract altitude）,
> ADR-0004 D31/D35（system 層参照・人間可読文書）, ADR-0005 D37（厳格さはコードで強制）,
> ADR-0007 D46-47（lazy-but-coherent）。system 層 data-model（契約スキーマ）は seed 予定として前方参照する。
>
> **チャットで指摘（自動採点不能）**: AI 補助の質・分担の良し悪し・人間可読性の主観評価は契約化できない
> （contract altitude）。別票に分けず、必要時にチャットで人間に指摘し、人間が扱いを判断する。

## サブ機能一覧

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| AUTH-A | 共著補助（協業ループの成果物産出） | 高 |
| AUTH-B | 整合ゲート（被覆・renumber 禁止・manual 不在の決定的強制） | 高 |
| AUTH-C | 署名と版固定（contract-approved・ApprovedSpecRef・status 派生） | 高 |
| AUTH-D | ドリフト二段検知（path 粗検知 → AC 単位構造 diff → 再署名） | 中 |

## AUTH-A 共著補助

**ユーザーストーリー**

- 誰が: 機能オーナー（人間）と著述補助 AI
- 何を: 決まった機能方向を、設計層が消費できる **well-formed な受け入れ契約**（spec.md ＋ acceptance.yaml）に落とす
- なぜ: 全フローの最上流。ここで観測可能な WHAT が確定しないと、下流の設計・実装・採点が共通の契約を持てない

**事前条件**

- 機能方向は既に決定済み（本層は WHAT を著すのであって、やるか否かは問わない）。
- **分担（プロセス・自動採点不能）**: 受け入れ基準（GWT behavior）は人間が所有・記述し、AI は severity ＋
  verification を提案する。誰がどちらを書いたかは契約化せず、成果物の**分離**のみを AC 化する（AUTH-002）。
- **system 層 data-model（契約スキーマ）への前方参照**: AC-ID／GWT／method enum／join キーの**形式**は
  system 層が定義する。greenfield 初回は未整備のため seed 待ち（AUTH-FR-011・設計層が seed する順序に従う）。

**受け入れ基準**

- **[AC-AUTH-001] 正常系: well-formed な成果物契約を産む**
  - Given 決定済みの機能方向と、参照可能な（または前方参照中の）system 層の固定制約がある
  - When 人間が GWT 受け入れ基準を spec.md に、AI が severity ＋ verification を acceptance.yaml に著す
  - Then spec.md は「サブ機能一覧 ＋ 各サブ機能（ユーザーストーリー／事前条件／受け入れ基準[GWT]／非機能／
    完了条件）＋ レッドライン」を持ち、各受け入れ基準シナリオは**機械抽出可能な AC-ID を1つ**持つ

- **[AC-AUTH-002] 正常系: behavior と grading が別ファイルに分離して着地する**
  - Given 同一 AC-ID で結ばれる spec.md と acceptance.yaml がある
  - When 成果物を観測する
  - Then GWT behavior は spec.md にのみ存在し、severity ／ verification（method ＋ expected）は
    acceptance.yaml にのみ存在する（spec.md に severity / method キーが混入せず、acceptance.yaml に GWT 散文が
    混入しない）。両者は AC-ID で双方向に join できる

**非機能要件**

- 人間可読性: spec.md は人間が編集する Markdown（表・GWT 可）。grader 向け詳細は acceptance.yaml に逃がす。
- AI 補助 ＋ コード強制: 著述は人間 ＋ 任意の AI 補助。契約形式・整合の**強制はコード**が担い、特定 skill を
  必須にしない（ADR-0003 D28・ADR-0005 D37）。

> 上記のうち「AI 補助の質」「人間可読性の主観評価」は自動採点できない。チャットで人間に指摘し人間が判断する。

**完了条件**

- 自動テスト: 構造抽出（AC-ID 抽出・節の存在）と分離（behavior/grading のファイル別着地）の unit_test が緑。
- デモ: 人間が spec.md を読み、受け入れ基準が機能の WHAT を過不足なく表していると検証宣言する。

## AUTH-B 整合ゲート

**ユーザーストーリー**

- 誰が: 署名ゲート（決定的コード ＝ check-spec / lint・pre-commit）
- 何を: 署名前に契約の整合性（被覆・採番・自動採点性）を機械的に保証する
- なぜ: 整合が崩れた契約は join できず、未検証の AC が下流へ漏れる。厳格さは人間の注意力でなくコードで担保する

**事前条件**

- spec.md と acceptance.yaml が同じ spec ディレクトリに存在し、ともにパース可能。
- 採番・整合の不変条件の SoT は**コード**（check-spec.ts / src の lint）であり、散文に再実装しない（ADR-0005 D37）。

**受け入れ基準**

- **[AC-AUTH-003] 正常系: 整合した契約を通す**
  - Given spec.md の AC-ID 集合と acceptance.yaml のキー集合が双方向一致し、重複が無く、全 method が自動採点
  - When 署名ゲートの整合チェックを走らせる
  - Then チェックは合格（exit 0 ／ ok=true）し、署名可能水準に達する

- **[AC-AUTH-004] 異常系: renumber／重複を落とす**
  - Given spec.md 内で同一 AC-ID が二度現れる（renumber・再利用）
  - When 署名ゲートを走らせる
  - Then 当該重複 AC-ID を列挙して fail（落とす）。AC-ID は join キーであり一度振ったら不変

- **[AC-AUTH-005] 異常系: 被覆漏れを落とす**
  - Given spec.md の AC-ID 集合と acceptance.yaml のキー集合が片側にしか無い ID を含む
  - When 署名ゲートを走らせる
  - Then 不一致の AC-ID（spec のみ／acceptance のみ）を方向付きで列挙して fail

- **[AC-AUTH-006] 異常系: manual method を落とす**
  - Given acceptance.yaml のいずれかの AC が非自動採点 method（manual）を持つ
  - When 署名ゲートを走らせる
  - Then 当該 AC-ID を列挙して fail。自動採点できない要件は契約に混ぜずチャットで人間に指摘する

**非機能要件**

- 決定性: 同一入力に対し同一結果。判定は AI 推論でなく純関数。

**完了条件**

- 自動テスト: 通過1件＋落とす3系統（重複・被覆漏れ・manual）の unit_test が緑。

## AUTH-C 署名と版固定

**ユーザーストーリー**

- 誰が: 機能オーナー（人間・署名者）と署名を永続するコード
- 何を: 整合した契約に人間が署名し、`contract-approved` を改竄不能な形で版固定する
- なぜ: 設計・実装は「どの版の契約に合意したか」を一意に参照する必要がある。口頭合意では版が滑る

**事前条件**

- AUTH-B の整合チェックが通過済み（lint 通過＝署名可能水準）。
- 署名状態の最初の永続先は **spec 状態オブジェクト**（issue は decomposed 後にしか生まれないため）。
- **目標挙動**: store／署名ゲートは loop 1 未ブートストラップで未実装。本 AC は実装状況に依存しない目標挙動を述べる。

**受け入れ基準**

- **[AC-AUTH-007] 正常系: 署名が ApprovedSpecRef を版固定で永続する**
  - Given 整合チェック通過済みの spec.md ＋ acceptance.yaml と、人間の署名行為
  - When 署名が成立する
  - Then ApprovedSpecRef が spec 状態オブジェクトに永続し、署名 commit の SHA・spec.md / acceptance.yaml の
    blob gitSha・AC 単位の acFingerprints（GWT behavior ＋ severity ＋ verification のハッシュ）・参照した
    system 要素の systemRefs（版固定）を含み、approvedAcIds が現 AC 全集合を覆う

- **[AC-AUTH-008] 正常系: status は approvedAcIds から派生する集約値**
  - Given ApprovedSpecRef.approvedAcIds と現 AC 全集合がある
  - When status を問う
  - Then status は両者から導出され、`approvedAcIds ⊇ 現 AC 全集合` のとき `approved`、不足があれば
    `co-authoring`（status を直接書き込まない・派生のみ）

**非機能要件**

- 監査性: 署名 commit SHA と blob SHA で真正性を後から検証できる。
- 入力決定性: 同一 blob gitSha は同一の resolve 入力を保証する。

**完了条件**

- 自動テスト: 署名後の spec 状態オブジェクトに ApprovedSpecRef の全フィールドが揃う db_state_check／
  status 派生の unit_test（目標挙動・store 実装後に実行検証）。

## AUTH-D ドリフト二段検知

**ユーザーストーリー**

- 誰が: ドリフト検知コード
- 何を: 署名後に契約が変わったとき、**変わった AC だけ**の署名を失効させる
- なぜ: 1 行の修正で契約全体の署名を捨てると再署名コストが過大になり、逆に放置すると古い署名が残り危険

**事前条件**

- AUTH-C で署名済み（approvedAcIds が全 AC を覆い status は approved）。
- 検知は二段: ①粗検知（ref の blob SHA と HEAD 比較で変更有無）→ ②AC 単位の構造 diff（現ハッシュ vs acFingerprints）。
- **目標挙動**: drift 検知は未実装。本 AC は目標挙動を述べる（fingerprint 正規化の実装確定は別件）。

**受け入れ基準**

- **[AC-AUTH-009] 正常系: 1 AC の GWT 変更は当該 AC のみを失効させる**
  - Given 署名済みの契約
  - When ある1つの AC の GWT（または severity / verification）を変更してコミットする
  - Then 粗検知が変更を捉え、AC 単位の構造 diff が**当該 AC-ID のみ**を approvedAcIds から外し、未変更 AC の
    署名は保持され、status は派生的に `co-authoring` に落ちて当該 AC の再署名を要求する

- **[AC-AUTH-010] 異常系: AC 追加は被覆漏れで status を降格させる**
  - Given 署名済みの契約
  - When 新しい AC を spec.md と acceptance.yaml に1つ追加する
  - Then approvedAcIds が新 AC を覆わず、被覆漏れにより status が派生的に `co-authoring` へ降格し再署名要求が立つ

- **[AC-AUTH-011] 耐障害性: AC 削除は残存署名を壊さず孤児検知と連動する**
  - Given 署名済みの契約
  - When ある AC を spec.md と acceptance.yaml から削除する
  - Then 当該 AC-ID が approvedAcIds と acFingerprints から除去され、残存 AC の被覆が満ちていれば再署名は不要で、
    削除は設計層の孤児（orphan）検知と連動する

**非機能要件**

- 安定性: fingerprint の正規化により、意味の変わらない整形差分で誤って失効させない（正規化方法は実装で確定）。

**完了条件**

- 自動テスト: 変更1件のみ失効／追加で降格／削除で除去の unit_test（fingerprint diff・目標挙動）。

## レッドライン

> 実装が**絶対にしてはならない**こと。Generator・Coordinator への明示的禁止。

- 実行層（Coordinator / Generator）が spec.md を書き換えない。SoT は人間。
- 実装後に受け入れ基準を緩めない。
- AC-ID を renumber・再利用しない（join キーかつ署名の単位）。
- acceptance.yaml に manual（非自動採点）method を混ぜない。自動採点不能はチャット指摘へ。
- spec.md に frontmatter を持たせない（meta・署名は spec 状態オブジェクト ＝ ApprovedSpecRef）。
- ドメイン／データ／契約スキーマを spec.md に**埋め込まない**。system 層 data-model を前方参照する（ADR-0004 D31）。
