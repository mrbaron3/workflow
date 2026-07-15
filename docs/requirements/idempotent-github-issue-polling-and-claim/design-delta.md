# Design delta — idempotent-github-issue-polling-and-claim

- mode: top-down
- context(s): intake
- summary: ADR-0008 I1/I3の入口として、ready GitHub Issueのstore-first・idempotent claimを追加する。

```yaml
reads:
  - elementId: ARCH-execution-001
  - elementId: ARCH-execution-002
  - elementId: ARCH-execution-009
extends:
  - elementId: LANG-intake-001
  - elementId: LANG-intake-002
  - elementId: LANG-intake-003
  - elementId: LANG-intake-004
  - elementId: LANG-intake-005
  - elementId: LANG-intake-006
  - elementId: LANG-intake-007
  - elementId: DOM-intake-001
  - elementId: DOM-intake-002
  - elementId: DOM-intake-003
  - elementId: DOM-intake-004
  - elementId: DOM-intake-005
  - elementId: DOM-intake-006
  - elementId: DOM-intake-007
  - elementId: DOM-intake-008
  - elementId: ARCH-intake-001
  - elementId: ARCH-intake-002
  - elementId: ARCH-intake-003
  - elementId: ARCH-intake-004
  - elementId: ARCH-intake-005
  - elementId: DATA-intake-001
  - elementId: DATA-intake-002
  - elementId: DATA-intake-003
  - elementId: DATA-intake-004
```

## Notes

- ready semanticsはconfigurable label、v1既定`ready`としてADR-0008の未決点を具体化する。
- store recordをexternal label変更より先にsaveし、外部失敗をclaim-pendingとして再開可能にする。
- planning/Issue生成はFEAT-017へ分離し、粗いbodyを直接execution contractとして扱わない。
