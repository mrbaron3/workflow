# Design delta — provider-neutral-interactive-session-backend

- mode: top-down
- context(s): agent-runtime, execution
- summary: tmux/sentinel/liveness契約を保ったまま、Claude/Codexのcommand差をprovider adapterへ移す。

```yaml
reads:
  - elementId: ARCH-execution-003
  - elementId: ARCH-execution-005
  - elementId: ARCH-execution-014
  - elementId: ARCH-agent-runtime-001
extends:
  - elementId: LANG-agent-runtime-003
  - elementId: LANG-agent-runtime-004
  - elementId: LANG-agent-runtime-007
  - elementId: DOM-agent-runtime-004
  - elementId: DOM-agent-runtime-008
  - elementId: ARCH-agent-runtime-002
  - elementId: ARCH-agent-runtime-003
  - elementId: DATA-agent-runtime-005
```

## Notes

- tmuxはsession/window transportでありproviderではない。command構築とready markerだけをadapter registryへ移す。
- v1は端末に存在しflagを確認できたClaude Code/Codexを実装し、Gemini/mock interactiveはunsupported。
- reviewerはtestとsidecar出力が必要なため両adapterでworkspace-writeを使い、source edit guardはD6の
  detached workspace + phase-3 classificationで維持する。
