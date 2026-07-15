# Design delta — target-rooted-authoring

- mode: top-down
- context(s): workspace, planning, authoring
- summary: 著述チェーン全体の文書・git・system view rootをTarget Repositoryから一意に解決し、外部targetとself-hostingで同じ契約を保つ。

```yaml
reads:
  - elementId: LANG-authoring-005
  - elementId: LANG-authoring-006
  - elementId: DOM-planning-004
  - elementId: DOM-planning-005
  - elementId: DOM-planning-009
  - elementId: LANG-workspace-003
extends:
  - elementId: LANG-workspace-008
  - elementId: DOM-workspace-008
  - elementId: ARCH-workspace-007
  - elementId: DATA-workspace-004
```

## Notes

- `resolveTargetRoot`をspawn-specsとsignの共通seamにし、commandごとのcwd推測を排除する。
- SpecStateとOrganization Storeはharness側に残し、要求文書・system view・署名blobはtarget repoが所有する。
- 外部repoのcommitは人間/target側の行為であり、著述チェーンは生成・読取り・組織状態記録だけを行う。
- `repo='.'`とtarget未設定は従来どおりharness rootへ解決し、legacy spec dirの意味論を変えない。
