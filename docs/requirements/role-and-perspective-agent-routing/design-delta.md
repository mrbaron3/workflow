# Design delta — role-and-perspective-agent-routing

- mode: top-down
- context(s): agent-runtime, execution
- summary: roleとreview Perspectiveからprovider/modelを決定論解決し、既存session backendとinvocation監査へ配線する。

```yaml
reads:
  - elementId: ARCH-agent-runtime-001
  - elementId: ARCH-agent-runtime-002
  - elementId: ARCH-agent-runtime-003
  - elementId: ARCH-execution-002
  - elementId: ARCH-execution-006
extends:
  - elementId: LANG-agent-runtime-003
  - elementId: LANG-agent-runtime-004
  - elementId: LANG-agent-runtime-005
  - elementId: LANG-agent-runtime-006
  - elementId: DOM-agent-runtime-003
  - elementId: DOM-agent-runtime-006
  - elementId: DOM-agent-runtime-009
  - elementId: ARCH-agent-runtime-004
  - elementId: DATA-agent-runtime-006
```

## Notes

- legacy configの挙動をdefault routeとして保持し、routes未設定のmigrationを不要にする。
- generator route providerはassign/adopt/poll guardのAI所有者にも使い、assigned providerと実行providerをずらさない。
- reviewer routeはPerspectiveごとに解決し、1 panel内でClaude/Codexを混在可能にする。
