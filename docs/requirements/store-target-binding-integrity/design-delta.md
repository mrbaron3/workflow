# Design delta — store-target-binding-integrity

- mode: top-down
- context(s): workspace
- summary: D5で観測されたtarget切替時のstore混線を閉じるため、1 store = 1 targetのWorkspace境界と
  fail-closedなmutation preflightをsystem層へ追加する。

```yaml
reads:
  - elementId: ARCH-evaluation-008
extends:
  - elementId: LANG-workspace-001
  - elementId: LANG-workspace-002
  - elementId: LANG-workspace-003
  - elementId: LANG-workspace-004
  - elementId: LANG-workspace-005
  - elementId: LANG-workspace-006
  - elementId: LANG-workspace-007
  - elementId: DOM-workspace-001
  - elementId: DOM-workspace-002
  - elementId: DOM-workspace-003
  - elementId: DOM-workspace-004
  - elementId: DOM-workspace-005
  - elementId: DOM-workspace-006
  - elementId: DOM-workspace-007
  - elementId: ARCH-workspace-001
  - elementId: ARCH-workspace-002
  - elementId: ARCH-workspace-003
  - elementId: ARCH-workspace-004
  - elementId: ARCH-workspace-005
  - elementId: ARCH-workspace-006
  - elementId: DATA-workspace-001
  - elementId: DATA-workspace-002
  - elementId: DATA-workspace-003
```

## Notes

- 新規`workspace`コンテキストへのadditiveな初回追加。既存planning/execution/evaluationの語彙は再定義しない。
- v1のTarget Identityはローカルで決定可能なcanonical repository rootを使い、remote無しtargetも扱う。
  repository移動を自動rebindするmigrationは今回の範囲外とし、曖昧な推測を避ける。
- D6のreview workspaceはexecutionの別Featureであり、同名のworkspaceでも本コンテキストの
  Organization Store ↔ Target Repository境界とは混同しない。
