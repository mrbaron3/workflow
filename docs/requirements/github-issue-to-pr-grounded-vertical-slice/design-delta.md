# Design delta — github-issue-to-pr-grounded-vertical-slice

- mode: top-down
- context(s): intake, agent-runtime, execution, evaluation
- summary: ready Source Issueからplanning/trace gate/既存live drive/GitHub PR gateまでを1 development turnに合成する。

```yaml
reads:
  - elementId: ARCH-intake-002
  - elementId: ARCH-intake-007
  - elementId: ARCH-intake-008
  - elementId: ARCH-agent-runtime-002
  - elementId: ARCH-agent-runtime-004
  - elementId: ARCH-execution-001
  - elementId: ARCH-execution-006
  - elementId: ARCH-execution-008
extends:
  - elementId: ARCH-intake-009
  - elementId: ARCH-intake-010
  - elementId: DATA-intake-008
```

## Notes

- 既存drive/panel/gateは変更せずrunLoopLiveを呼ぶ。入口固有状態をexecution statusへ混ぜない。
- production planning sessionはClaude/Codex共通adapter、detached workspace、sidecar、livenessを再利用する。
- remote無し環境ではGitHub I/Oと実providerをfakeに差し替えたintegration testまでを恒久guardとし、
  実remote grounded runは環境が用意された時に同じseamで行う。
