# Registration Control Ubiquitous Language

| ID | 用語 | 定義 |
| --- | --- | --- |
| LANG-registration-control-001 | Desired State | operator が Registration に保存した起動意図。 |
| LANG-registration-control-002 | Actual State | supervisor が特定 Registration version について最後に永続観測したcomponent状態。 |
| LANG-registration-control-003 | Status Projection | desired、actual、freshness、poll/delivery/job指標を同じDB snapshotから組み立てたread model。 |
| LANG-registration-control-004 | Dynamic Supervision | Registrationの追加・更新・無効化にprocess再起動なしでcomponent集合を収束させること。 |
| LANG-registration-control-005 | Convergent Work Identity | webhookとpollを跨いで同じGitHub revisionを一意にするrepository/kind/number/updated-at key。 |
| LANG-registration-control-006 | Fail-closed Registration | unknown、disabled、stale、DB不達時に新しいjobやhealthy表示を作らない境界。 |
| LANG-registration-control-007 | Experience Design Gate | approved revision/digestと完全なCapability coverageだけをControl API契約へ通す起動前hard gate。 |
| LANG-registration-control-008 | Truth Recovery | notificationをhintとし、周期DB reconciliationでdesired/deliveryを再発見する回復経路。 |
| LANG-registration-control-009 | Manual Retry Attempt | observed route-attemptに束縛され、idempotentかつ監査可能なoperator command。 |
| LANG-registration-control-010 | Compatibility Oracle | PR #9由来のTypeScript registry/router/forwarder/poll behaviorを回帰比較する非永続model。 |
| LANG-registration-control-011 | Operating Mode | `MONITOR_ONLY` または `ACTIVE` のread-only control-process authority。前者は観測を続けるがenqueue/lease/executionを許可しない。 |
| LANG-registration-control-012 | Component Freshness | component自身のobservedAtと300/300/60/30/15秒budgetから決める`fresh\|stale\|unknown`。query成功時刻はlast-goodではない。 |
| LANG-registration-control-013 | Last Good | 同componentが過去にauthoritativeに正常だったhistorical evidence。現在failureをhealthyに塗り替えない。 |
| LANG-registration-control-014 | Recovery State | `none\|scheduled\|in_progress\|blocked\|recovered\|unknown` の明示的な回復進行度。新しいauthoritative snapshot前にrecoveredとしない。 |
| LANG-registration-control-015 | Browser Operator Session | exact loopback originから一回限りbootstrapで得るserver-side session。browserはHttpOnly cookieとmemory-only CSRF proofだけを持つ。 |
| LANG-registration-control-016 | Command Outcome | idempotency identity、observed/current fence、`applied\|duplicate\|version_conflict\|rejected\|indeterminate`、recorded timeを持つdurable command結果。 |
