# Design delta — verification-method-grader-command-registry

- mode: top-down
- context(s): execution, evaluation
- summary: verification methodごとの実commandをAC単位でgroundし、同じ実行手段を回帰へcaptureする。

```yaml
reads:
  - elementId: ARCH-execution-006
  - elementId: ARCH-execution-010
  - elementId: DATA-execution-001
  - elementId: DOM-execution-008
extends:
  - elementId: LANG-execution-018
  - elementId: LANG-execution-019
  - elementId: DOM-execution-011
  - elementId: DOM-execution-012
  - elementId: ARCH-execution-018
  - elementId: ARCH-execution-019
  - elementId: DATA-execution-009
```

## Notes

- unit_testはVitest structured reportを共有し、非unit methodはAC単位commandで実行する。
- `scope_check`はchanged filesを読むintrinsic checkであり、外部commandを要求しない。
- artifact evidenceはlive buildの証拠、EvalTask.graderCommandsは回帰時点まで実行手段を運ぶ耐久記録である。
