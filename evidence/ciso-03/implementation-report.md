# CISO-03 実装・検証証跡

## Identity

- Issue: [mrbaron3/workflow#13](https://github.com/mrbaron3/workflow/issues/13)
- Base: `origin/main` / `ee590b3361cd2b0f62e7ffa1e2fcfba1a16dac91`
  （CISO-02 mergeをancestor確認済み）
- Branch: `mrbaron3/ciso-03-registration-control`
- Control implementation: `cmd/agentops-control`, `internal/control`, `internal/designgate`
- Published API: `contracts/control-api/v1/openapi.yaml`
- Database: `agentops_control` schema version 2、PostgreSQLのみ

## Experience design gate lineage

| 要素 | 固定値 |
| --- | --- |
| Provider | `mrbaron3/designflow@contract-v1.0.0-rc.1` |
| Provider tag object | `a5598951bbc405f9d83ebbccc184c7994844715b` |
| Provider commit | `ce732a80a8c3867b4ac881531ce8f7546e001dbb` |
| Request | `design-dashboard-001` |
| Approved revision | `design-revision-001` |
| Bundle digest | `sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97` |
| Human decision | `design-decision-001` / `approve` |
| Repository decision | ADR-0012 at workflow commit `6abbad547404e1b4a45ea42a9bce851525702251` |

Provider examplesは`contracts/designflow/contract-v1.0.0-rc.1/`へbyte-for-byte pinし、
`PROVENANCE.json`へtag/commitを記録した。`internal/designgate`はmanifest source/artifact/bundleのRFC 8785 digest、
safe relative path、request/revision lineage、human approvalとbundle digest binding、zero ambiguity、Capability fieldの
完全性、Capabilityごとのquery/command・auth・freshness・idempotency・failure・retry/cancel・audit facet、
API/system/Issue AC coverageをControl API起動前に検証する。

負例はunapproved、digest mismatch、mixed revision、unresolved ambiguity、incomplete capability、zero/partial coverageを
決定論的に拒否する。Capabilityごとの変換は
`evidence/ciso-03/design-capability-trace.json`から
`contracts/control-api/v1/openapi.yaml`、
`docs/_system/registration-control/architecture.md`、AC-CISO-001/002へ追跡できる。

## Acceptance mapping

| Issue requirement | Implementation / evidence |
| --- | --- |
| AC-CISO-001: enabled + monitor flagだけを稼働 | `Registration.Desired`、`Supervisor.Reconcile`、unknown/disabled/stale/capability/execution router guards、supervisor/router tests |
| AC-CISO-002: 再起動なし変更と再起動復元 | version-scoped component restart、LISTEN wake + periodic reconciliation、Apple smokeのenable/disable/reconnect/restart |
| Registration create/update/disable | bearer-auth Control API、create idempotency、`If-Match` update/disable、transactional audit |
| dynamic Issue/PR monitor | Registration全件からsupervise、GitHub Open Issue/PR discovery、cursor保存、個別start/stop/restart |
| Forwarder supervision | fixed `gh webhook forward --repo --events` adapter、stdout pipe、repository identity検証、exit/backoff/restart、actual state |
| persist-before-ack/dedup/retry | HMAC検証、global delivery key + payload conflict、commit後202、lease/expiry/backoff、idempotent manual retry |
| webhook + poll convergence | repository/kind/number/updated-atのlogical idempotency key、DB unique/single-flight制約 |
| desired vs actual | version/freshness付き`monitor_actual_states`とrepeatable-read anomaly-first projection |
| fail closed | schema/DB startup拒否、DB reconciliation失敗で全component停止、status 503 + last-success/retry hint、理由付きignored、stale job trigger |
| missed notification recovery | notificationはwakeのみ、supervisor/routerは周期DB query、LISTENはbackoff再接続 |
| PR #9 migration | registry/router/forwarder/poll behaviorをGo + deterministic regressionsへ移し、TypeScriptは非永続oracle |
| CISO-01/02 invariants | PostgreSQL/runnerはhost非公開、controlはloopbackのみ、標準OCI、evaluation JSON無変更、dual-writeなし |

## Security invariants

- Operator routesはbearer tokenをconstant-time比較し、public webhookはHMAC secret未設定時に無効。
- Request bodyは10 MiB、request contextは5秒、server read/write timeoutを設定する。
- Registrationはcanonical `owner/name`と列挙switchだけを受け、configurationは空object以外を拒否する。
  任意command、host path、credentialを保存・実行しない。
- Forwarder child argvへwebhook secretやsigning endpointを渡さず、repository identityをpayloadと再照合する。
- Durable headersはallowlistのみでcredential/signatureを保存しない。
- PostgreSQL schema/checksum不一致、DB不達、unknown/disabled/stale Registrationはfail closed。
- State mutationとruntime auditは同じtransactionでcommitする。

## Migration / cutover

1. CISO-02 migration 1にmigration 2を明示適用する。通常control起動はDDLを行わず、両filename/checksumの完全一致だけを
   verifyする。
2. `agentops-control`を同じinternal networkで起動し、controlだけを`127.0.0.1`へpublishする。
3. Control APIでrepository Registrationを作成する。fixed repository listは起動引数、env、個別fileに置かない。
4. 旧TypeScript webhook daemonはproductionではfail closedのまま維持し、同時起動・JSON fallback・dual-writeをしない。
   旧modelはPR #9 behaviorのunit compatibility oracleとしてだけ残す。
5. evaluation-domain `.harness/db.json`とそのJSON契約は変更しない。

## Validation evidence

Fast-to-slowの順で実行する。Review修正後の最終結果とreview task/dispatch IDは本ファイルと
`evidence/ciso-03/reviews.json`へ追記する。

| Validation | Result |
| --- | --- |
| Targeted Go unit | PASS (`go test ./...`) |
| Go race | PASS (`go test -race ./...`、20 test functions) |
| TypeScript contract targeted | PASS (5 tests) |
| TypeScript typecheck | PASS |
| Full TypeScript suite | PASS (91 files passed, 1 skipped; 774 tests passed, 17 skipped) |
| Provider byte comparison | PASS (tag target commit + `contracts/v1/examples` exact) |
| OCI control build | PASS (Go 1.24 builder、nonroot control image) |
| Go race + PostgreSQL integration | PASS (Apple internal network、host publishなし) |
| Apple Container grounded boundary smoke | PASS (10/10: dynamic reconfiguration、desired/actual、DB disconnect/reconnect、restart、publish invariants) |
| Final post-review rerun | pending |
| Review Round 1 | pending |
| Review Round 2 | pending |

## Review policy

各roundで同じcommitted headを独立Codex reviewerとClaude reviewerへread-onlyで渡す。reviewerは検査/testだけを行い、
file/commit/push/PRを変更しない。Codex implementation ownerだけがconfirmed findingを修正する。Round 2修正後に
Round 3は実行しない。
