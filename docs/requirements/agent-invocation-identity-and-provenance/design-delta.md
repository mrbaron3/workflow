# Design delta — agent-invocation-identity-and-provenance

- mode: top-down
- context(s): agent-runtime, execution, evaluation
- summary: provider/model非依存化の最初のvertical sliceとして、共通invocation identity、耐久provenance、
  reviewer EvalRun linkageを追加する。

```yaml
reads:
  - elementId: ARCH-execution-003
  - elementId: ARCH-execution-006
  - elementId: ARCH-execution-009
  - elementId: DATA-execution-006
extends:
  - elementId: LANG-agent-runtime-001
  - elementId: LANG-agent-runtime-002
  - elementId: LANG-agent-runtime-003
  - elementId: LANG-agent-runtime-004
  - elementId: LANG-agent-runtime-005
  - elementId: LANG-agent-runtime-006
  - elementId: LANG-agent-runtime-008
  - elementId: DOM-agent-runtime-001
  - elementId: DOM-agent-runtime-002
  - elementId: DOM-agent-runtime-003
  - elementId: DOM-agent-runtime-005
  - elementId: DOM-agent-runtime-006
  - elementId: DOM-agent-runtime-007
  - elementId: ARCH-agent-runtime-001
  - elementId: ARCH-agent-runtime-005
  - elementId: DATA-agent-runtime-001
  - elementId: DATA-agent-runtime-002
  - elementId: DATA-agent-runtime-003
  - elementId: DATA-agent-runtime-004
```

## Notes

- Provider adapterとroute configそのものはFEAT-014/015に残し、FEAT-013では現行backendが実際に起動した
  provider (`claude`) を正確に記録する。
- 既存PromptRecordは削除せずlegacy read modelとして維持し、新規AgentInvocationとdual-writeしない。
- deterministic functionality graderはAI invocationではないためEvalRun.invocationKey=nullを維持する。
