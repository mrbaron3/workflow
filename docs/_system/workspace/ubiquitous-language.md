# ユビキタス言語 — workspace コンテキスト

> workspace コンテキストは、1つの開発組織 store がどの target repository の状態を所有するかを定める。
> planning / authoring / execution / evaluation はこの束縛を参照し、target の同一性を再定義しない。
> 追加のみ（`LANG-workspace-NNN` は安定・renumber 禁止）。

| ID | 用語 | 意味（本コンテキスト全体で一貫して使う） |
| --- | --- | --- |
| LANG-workspace-001 | Workspace | 1つの Organization Store と、それが開発する1つの Target Repository を結ぶ運用境界。 |
| LANG-workspace-002 | Organization Store | roadmap / issue / PR / evidence 等の組織状態を保持する `.harness/db.json`。Target Repository 内へ複製しない。 |
| LANG-workspace-003 | Target Repository | Workspace が WHAT・コード・検証を扱う単一の git repository。self-hosting では harness repository 自身。 |
| LANG-workspace-004 | Target Identity | 同じ Target Repository を設定表記の違いから独立して照合する、正規化済みの耐久識別子。 |
| LANG-workspace-005 | Target Binding | Organization Store と Target Identity の一回限りの耐久的な対応付け。通常運転では別 target へ変更しない。 |
| LANG-workspace-006 | Binding Mismatch | state-changing operation が要求する Target Identity と、store の Target Binding が異なる状態。書込み前に拒否される。 |
| LANG-workspace-007 | Legacy Unbound Store | Target Binding導入前から組織状態を持つため、安全なtargetを機械推測できないOrganization Store。 |
| LANG-workspace-008 | Authoring Target Root | spawn・署名・Issue分解・契約起案がWHAT文書とgitを読む単一のrepository root。Target Repositoryから決定し、commandごとに別rootを推測しない。 |
