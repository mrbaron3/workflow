# Design delta — dedicated-ui-design-authoring-agent

- mode: top-down
- context(s): intake, agent-runtime, execution
- summary: UI Candidateごとに専用role sessionを起動し、AC-traceableなUI design artifactを検証後だけIssueと下流promptへ投影する。

```yaml
reads:
  - elementId: LANG-intake-011
  - elementId: DOM-intake-012
  - elementId: ARCH-intake-009
  - elementId: DOM-agent-runtime-003
  - elementId: DOM-agent-runtime-008
extends:
  - elementId: LANG-intake-012
  - elementId: DOM-intake-015
  - elementId: DOM-intake-016
  - elementId: ARCH-intake-012
  - elementId: ARCH-intake-013
  - elementId: DATA-intake-009
  - elementId: DOM-agent-runtime-009
```

## Notes

- `uiDesign` routeはprovider/model選択だけを担い、ui-designerのfresh contextはplanning route fallback時も共有しない。
- sidecar outputだけを書込み可能にし、checkout変更はartifact内容にかかわらずfailed provenanceになる。
- deterministic gateがschema、ambiguities、AC coverage、element linkage、Invocation provenanceを検証する。
- accepted artifactはIssueに一度だけprojectionされ、generatorとisolated reviewer sessionが同じPublished Languageを読む。
