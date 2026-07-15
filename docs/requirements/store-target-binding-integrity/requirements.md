# Store-target binding integrity 受け入れ要件

> 人間が確定したD5のWHATを、署名可能なFeature契約へ整えたもの。1つの組織storeが複数targetの
> roadmap / epic / issueを混在させないことを定義する。target identityの内部表現やCLI内部構造はHOWであり、
> system層のseamに委ねる。

## 意図（roadmap-planner が定めた outcome）

- 機能: Store-target binding integrity
- outcome（価値・なぜ今）: 1つの組織 store は1つの target repo に耐久的に束縛され、異なる target を
  向いた状態変更操作は書込み前に理由付きで拒否される。self-hosting と外部 target の往復は別 store に
  構造分離され、D5 の roadmap/epic 混線が再発しない。
- 計画の木リンク: feature=FEAT-011 epic=EPIC-06

## サブ機能一覧

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| STBIND-A | 新規storeの初回target束縛 | 高 |
| STBIND-B | mismatchの書込み前拒否 | 高 |
| STBIND-C | legacy storeの安全な移行 | 高 |
| STBIND-D | read-only観測とstore分離 | 高 |

## STBIND-A 新規storeの初回target束縛

**ユーザーストーリー**

- 誰が: 複数repositoryを開発するハーネス利用者
- 何を: 新しい組織storeが最初に扱ったtarget repositoryへ自動的かつ耐久的に束縛される
- なぜ: configを書き換えただけで、同じstoreが別製品の状態を受け入れ始めないようにするため

**受け入れ基準**

- **[AC-STBIND-001] 正常系: 空storeは最初の状態変更時にtargetへ一度だけ束縛される**
  - Given 組織状態もTarget Bindingも持たないstoreと、有効なtarget設定がある
  - When targetに関係する最初の状態変更操作を実行する
  - Then storeはそのTarget Identityを耐久保存して操作を続行し、同じtargetでの再実行はbindingを
    増殖・更新せず従来どおり動作する

- **[AC-STBIND-002] 境界系: 同じrepositoryの等価なpath表記は同じtargetとして扱う**
  - Given storeがあるtargetへ束縛済みである
  - When `.` / 絶対path / 解決可能なpath aliasなど、同じrepositoryを指す設定で状態変更する
  - Then Binding Mismatchにならず、単一のbindingが維持される

## STBIND-B mismatchの書込み前拒否

**ユーザーストーリー**

- 誰が: self-hostingと外部themeを切り替えるoperator
- 何を: 誤ったstore/config組合せを、状態を壊す前に理由付きで拒否してほしい
- なぜ: D5では外部roadmapがself storeのvisionと同名epicへ混入し、再取込でも戻らなかったため

**受け入れ基準**

- **[AC-STBIND-003] 異常系: 束縛先と異なるtargetの状態変更は一切の変異前に拒否される**
  - Given target Aへ束縛済みでroadmap等の状態を持つstoreがある
  - When configだけをtarget Bへ向けてplan-roadmapその他の状態変更操作を開始する
  - Then 操作はbound targetとrequested targetを示して拒否され、roadmap / epic link / counters /
    spec filesを含むstoreとtargetの観測可能な状態は開始前と同一である

- **[AC-STBIND-004] 不変条件: 既存bindingを通常操作で別targetへrebindできない**
  - Given target Aへ束縛済みのstoreがある
  - When 初回束縛またはlegacy移行と同じ入口へtarget Bを渡す
  - Then rebindは拒否され、binding identityとboundAtは変わらない

## STBIND-C legacy storeの安全な移行

**ユーザーストーリー**

- 誰が: Target Binding導入前からハーネスを利用しているoperator
- 何を: 既存状態を失わず、どのtargetのstoreかを一度だけ明示したい
- なぜ: 非空storeの内容から正しいtargetを機械推測すると、D5の誤接続を正当化してしまうため

**受け入れ基準**

- **[AC-STBIND-005] 移行系: 非空の未束縛storeは自動束縛せず、明示移行後だけ状態変更できる**
  - Given Target Binding導入前の、状態を持つ未束縛storeがある
  - When 通常の状態変更操作を開始する
  - Then targetを推測せず理由付きで停止し、明示的な一回限りのtarget bindingを記録した後は
    同targetで従来の状態を保ったまま操作を続行できる

## STBIND-D read-only観測とstore分離

**受け入れ基準**

- **[AC-STBIND-006] 可観測性: mismatch中もread-onlyな監査は利用でき、別storeは独立して動く**
  - Given target Aへ束縛済みのstoreをtarget B設定から開いた、またはA/B用の2つのstoreがある
  - When status / plan-tree等のread-only観測を行い、別storeではtarget Bの状態変更を行う
  - Then Aの既存状態は観測でき、B用storeの操作はAのbinding・roadmap・issueを変更せず独立して成立する

## 非機能要件

- 決定論: 同じstore状態とtarget identityから同じ許可・拒否結果になる。
- fail-closed: identity不明、legacy未移行、mismatchのいずれも状態変更を開始しない。
- 可観測性: 拒否理由にbound/requested targetと安全な次の操作を含める。
- 互換性: targetが一致する既存コマンドの機能・出力データ・署名意味論を弱めない。

## レッドライン

- 非空のlegacy storeを現在configへ黙って自動束縛しない。
- 束縛済みstoreを通常コマンドや設定変更で別targetへrebindしない。
- preflight拒否より前にroadmap、counter、file、issue等を変異させない。
- target repository内へ第二のOrganization Storeを生成・複製しない。
- mismatchを理由に既存storeのread-only監査まで隠さない。
- 既存テストや署名・drift検知の合格基準を弱体化しない。
