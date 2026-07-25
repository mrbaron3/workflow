# Design delta — local-webhook-control-gui

- mode: top-down
- context(s): webhook
- summary: Repository RegistryとDurable Inboxをloopback HTTP UI/APIへ投影する。

```yaml
reads:
  - elementId: DATA-webhook-001
  - elementId: DATA-webhook-003
  - elementId: DATA-webhook-004
  - elementId: DOM-webhook-005
extends:
  - elementId: ARCH-webhook-006
```

## Notes

- GUIはcontrol planeの投影で、stateは専用JSON storeに住む。
- 初期版はframework不要のself-contained HTML/CSS/JSとNode HTTP serverでlocal-onlyに配布する。
- visual polishより、repo/event/consumer/delivery stateの誤操作防止とaccessible formを優先する。
