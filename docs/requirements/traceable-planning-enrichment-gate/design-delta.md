# Design delta — traceable-planning-enrichment-gate

- mode: top-down
- context(s): intake, planning, agent-runtime
- summary: claimed原文をplanning-agentの1..N Candidateへ昇格し、AC trace完全性が成立した場合だけ既存queueへ投影する。

```yaml
reads:
  - elementId: ARCH-agent-runtime-001
  - elementId: ARCH-agent-runtime-004
  - elementId: ARCH-execution-002
  - elementId: ARCH-execution-007
extends:
  - elementId: LANG-intake-008
  - elementId: LANG-intake-009
  - elementId: LANG-intake-010
  - elementId: DOM-intake-009
  - elementId: DOM-intake-010
  - elementId: DOM-intake-011
  - elementId: DOM-intake-012
  - elementId: DOM-intake-013
  - elementId: ARCH-intake-006
  - elementId: ARCH-intake-007
  - elementId: ARCH-intake-008
  - elementId: DATA-intake-005
  - elementId: DATA-intake-006
  - elementId: DATA-intake-007
```

## Notes

- planning-agentの非決定outputを決定論gateが検査する。gate自身はACを補完・修正しない。
- source traceは初回snapshotのtitle/bodyに含まれる非空text、system traceは現在の_systemで解決できるidだけを許す。
- ready labelはHOW委任の判断点なのでaccepted Issueはresolved generatorへ自動assignする。
