# Design delta — read-only-reviewer-workspace-integrity

- mode: top-down
- context(s): execution
- summary: D6のfalse escalationを閉じるため、reviewerのdisposable checkout、checkout外evidence、
  environment/source mutation分類を既存panel seamへ追加する。

```yaml
reads:
  - elementId: ARCH-execution-004
  - elementId: ARCH-execution-006
  - elementId: ARCH-execution-014
  - elementId: ARCH-execution-015
extends:
  - elementId: LANG-execution-015
  - elementId: LANG-execution-016
  - elementId: LANG-execution-017
  - elementId: DOM-execution-010
  - elementId: ARCH-execution-017
  - elementId: DATA-execution-008
```

## Notes

- build commitを不変にする境界は既存detached worktree isolationを再利用する。
- findingsだけをcheckout外sidecarへ移し、reviewerが書ける証跡とdirty判定対象を分離する。
- v1のEnvironment Artifact Mutationは既知lockfile名だけを明示allowlistにする。package manifest、
  source、未知生成物はfail-closedでsource change violationとなる。
- stuck/timeoutのsession/worktree保持とlate findings collectionは既存意味論を維持する。
