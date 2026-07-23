# Design delta — durable-github-webhook-inbox-and-normalized-routing

- mode: top-down
- context(s): webhook, intake, execution
- summary: GitHub deliveryをdurable triggerへ変換し、既存poll consumerと同じ決定論seamへrouteする。

```yaml
reads:
  - elementId: ARCH-webhook-003
  - elementId: DOM-webhook-004
  - elementId: DOM-execution-008
extends:
  - elementId: ARCH-webhook-001
  - elementId: ARCH-webhook-002
  - elementId: DATA-webhook-001
  - elementId: DATA-webhook-002
  - elementId: DATA-webhook-003
  - elementId: DATA-webhook-005
```

## Notes

- Inbox/registrationは長時間daemon専用storeへ分離し、Eval DBのread-modify-writeと競合させない。
- consumer adapterはNormalized Eventをwake signalとして受け、GitHub current snapshotを再取得する。
- 初期実装はin-process fake consumerで決定論検証し、real AgentOps/Orca adapterはFEAT-026で接続する。
