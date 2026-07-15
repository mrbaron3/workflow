# ドメインモデル — workspace コンテキスト

## エンティティと集約

- **DOM-workspace-001 Workspace aggregate** — identity: Organization Store のroot。`LANG-workspace-002`
  Organization Store と、0または1個の `LANG-workspace-005` Target Binding を所有する。
- **DOM-workspace-002 Target Identity value object** — `LANG-workspace-004` の正規化済み値。同じrepositoryを
  指す等価な設定は等しく、異なるrepositoryは異なる値になる。
- **DOM-workspace-003 Target Binding value object** — Target Identity と束縛時刻を持つ不変値。Workspaceに
  一度記録された後、通常のstate-changing operationから別identityへ置換されない。

## 関係と境界

- 1 Workspace はちょうど1 Organization Storeを持ち、束縛後はちょうど1 Target Repositoryを扱う。
- planning / authoring / execution / evaluation は Workspace が検証済みtarget rootを供給した後にだけ状態を変更する。
- 外部targetとself-hostingを往復するときはWorkspaceを分け、Organization Storeを共有しない。

## 不変条件・イベント・状態

- **DOM-workspace-004 Single-target invariant** — BoundなWorkspaceに対するBinding Mismatchは、下流の
  state-changing operationが始まる前に必ず拒否され、store・target file・counterのいずれも変異しない。
- **DOM-workspace-005 Binding state machine** — `unbound-empty → bound` は最初のstate-changing operationで
  自動遷移できる。`legacy-unbound → bound` は明示的な移行だけが許される。`bound → different-bound` は禁止。
- **DOM-workspace-006 TargetBound event** — Target Bindingが初めて耐久保存された事実。再実行は同一identityなら
  no-op、異なるidentityならBinding Mismatchとなる。
- **DOM-workspace-007 Read-only availability invariant** — Binding Mismatchがあっても、既存storeのstatus・監査・
  export等のread-only観測は失われない。禁止対象は状態変更だけである。
- **DOM-workspace-008 target-root consistency** — 同じWorkspaceのspawn-specs、sign、spawn-issues、contract-draftは
  同じAuthoring Target Rootを使う。外部targetではtarget repo、自己開発ではharness rootとなり、WHAT文書・git・
  system viewのrootがcommand間で分岐しない。
