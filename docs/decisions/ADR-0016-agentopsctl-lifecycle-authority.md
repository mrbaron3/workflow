# ADR-0016: `agentopsctl` を隔離基盤の短命 lifecycle authority とする

- 状態: 採択・実装済み（CISO-06）
- 親: #10／所有 Issue: #16／所有 AC: AC-CISO-007, AC-CISO-009
- 関連: [ADR-0013](ADR-0013-postgresql-control-plane-source-of-truth.md)、
  [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md)

## 文脈

control、runner、PostgreSQLを個別の手操作で起動すると、MacのListen、DB上の運転状態、実containerが分岐する。
特にACTIVEから直接停止すると、delivery routing、poll enqueue、lease取得と停止が競合し、実行中attemptを成功扱いしたり
重複実行したりし得る。反対にhost daemonを追加すると、新しいcredential保持主体と常駐障害点をMacへ作る。

## 決定

1. `agentopsctl start|drain|stop|status|logs|open`だけをoperator lifecycle入口とする。CLIは処理中だけ存在し、
   Apple Container systemの起動権限を使用するが、brew、launchd、host-native daemonを導入しない。
2. PostgreSQL schema version 4のsingleton `lifecycle_state`とappend-only
   `lifecycle_transitions`を運転状態の唯一の永続正本とする。状態遷移は
   `OFF → MONITOR_ONLY → ACTIVE → DRAINING → OFF|MONITOR_ONLY`だけを許し、同一idempotency keyの再送は
   同一transitionを返す。不正遷移とoperation failureもauditへ残す。
3. DRAININGをcommitしてから、新規delivery claim、poll/webhook enqueue、job leaseをDB row lockとtriggerの両方で停止する。
   runnerへSIGTERMを送り、既存attemptはその自然な停止点まで待つ。deadline超過時はrunnerをforce killせず、
   `drain_timed_out`とlast errorを保存して非0終了する。
4. 起動時はDB mode、active lease、running attemptとactual containerを照合する。persisted ACTIVEなのにtopologyが欠ける場合は
   まずDRAININGへ移し、in-flightが残る間は再開しない。ゼロならMONITOR_ONLYを経て要求modeへ復旧する。
   部分start失敗時はその試行が変更したcontainerだけを補償停止し、既存in-flight containerを巻き込まない。
5. Apple Container adapterは所有label付きnamed network/volume/containerだけを操作する。controlだけを
   `127.0.0.1:<operator-port>:8080`へexactly one publishし、runner/PostgreSQLはhost-only internal network上で
   publish/socketなしとする。controlはinternal networkとdefault networkのbridgeとしてallowlist済みHTTPS CONNECT
   （GitHub、GitHub API、選択provider）だけをrunnerへ提供する。
6. long-running control/runnerはread-only root、capability drop ALL、named/private mountだけで動く。runner volume初期化は
   network隔離されたremovable one-shot containerへ`CAP_CHOWN`だけを一時付与する。admin/control/runner DB roleと
   control/runner GitHub credential、provider credentialは分離し、runtime errorとargvでは値をredactする。
7. 通常stopはcontrol/runner/PostgreSQL containerを削除してListen消失を検査するが、PostgreSQL/runner named volumeと
   lifecycle履歴は削除しない。`status`はpersisted snapshotとactual inspectを併記し、DB停止時にmodeを推測しない。

## 帰結

- MONITOR_ONLYは監視/Dashboardだけを保ち、ACTIVEだけがenqueue/leaseを許す。
- DRAININGはCISO-05の公開API語彙へ追加せず、PostgreSQLとCLI statusだけが権威として表示する。control processは
  address/configを変更せず残し、DB fenceで新規workを止めながら既存runnerのegress proxyをdrain完了まで維持する。
- Apple Containerのcustom network DNSへ依存せず、actual inspectで得たinternal IPv4を短命起動ごとに解決する。
- 実provider/GitHub credentialを用いた外部side effect実行はこの安全なlifecycle smokeの対象外であり、既存runnerの
  expected-head/lease fenceが引き続き副作用境界を所有する。

## 実装先 id

- architecture: `ARCH-control-store-012`〜`015`、`ARCH-container-runtime-011`〜`014`
- domain-model: `DOM-control-store-010`〜`012`、`DOM-container-runtime-010`〜`012`
- data-model: `DATA-control-store-015`〜`016`、`DATA-container-runtime-007`
- ubiquitous-language: `LANG-control-store-016`〜`019`、`LANG-container-runtime-013`〜`015`
