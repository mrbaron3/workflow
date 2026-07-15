# Design delta — conditional-ui-design-readiness-gate

- mode: top-down
- context(s): intake, design
- summary: 検証済みUI design artifactが無いUI Candidateだけを明示的・冪等に停止する条件付き境界を追加する。

```yaml
reads:
  - elementId: DOM-intake-012
  - elementId: DOM-intake-013
  - elementId: ARCH-intake-007
  - elementId: ARCH-intake-008
extends:
  - elementId: LANG-intake-011
  - elementId: DOM-intake-014
  - elementId: ARCH-intake-011
```

## Notes

- v1のdetectorはCandidate.areaのfrontend/fullstackをUI境界とする。planning promptが正直な分類を要求する。
- 本featureはUI design artifactを生成しない。無根拠実装を遮断し、FEAT-021の専用agentが検証済みartifactで解除するseamを固定する。
- all-or-nothingと初回enrichment idempotenceは既存DOM-intake-012/013を再利用する。
