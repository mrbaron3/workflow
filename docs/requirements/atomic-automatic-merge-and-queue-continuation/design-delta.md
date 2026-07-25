# Design delta

- `RevisionGateSnapshot`をmerge判断の耐久証拠として追加する。
- production adapterは`gh pr view`とGraphQL review threadsを再取得し、
  `gh pr merge --match-head-commit`を`--admin`無しで呼ぶ。
- split intakeには`sourceClosedAt/sourceCloseError`を追加し、poll reconciliationでclose failureを再試行する。
