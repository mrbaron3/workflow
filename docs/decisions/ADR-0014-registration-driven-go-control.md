# ADR-0014: PostgreSQL Registration から Go control を動的に収束させる

- 状態: 採択・吸収・構造実装済み（CISO-03）
- 親: #10／所有Issue: #13／所有AC: AC-CISO-001, AC-CISO-002
- 前提: ADR-0010、ADR-0011、ADR-0013
- Experience input: `mrbaron3/designflow@contract-v1.0.0-rc.1`、repository ADR-0012
  （`6abbad547404e...` で検査した固定provider/digest-bound fail-closed方針）

## 文脈

PR #9 は複数repositoryのregistry/router/local forwarder/poll behaviorをTypeScriptのlocal control modelで
接地したが、CISO-02はdurable control stateの唯一の正本をPostgreSQLへ移し、JSON daemonのproduction起動を
意図的にfail closedにした。CISO-03ではoperatorがControl APIからRegistrationを変更した直後に、Issue/PR monitorと
forwarderが再構成され、webhookとpollが同じdurable queueへ収束する必要がある。またControl APIのcapabilityは、
実装者が推測したUIでなく、独立Experience Contract Providerのhuman-approved revision/digestへ束縛する必要がある。

## 決定

1. `agentops-control`をGoの単一control processとして実装する。起動時はapproved Experience bundle gate、
   PostgreSQL schema/checksum verification、必須credentialを順に検証し、いずれかが失敗すればHTTP/API、
   supervisor、routerを開始しない。
2. Control APIはRegistration create/update/disable、desired/actual status query、delivery retry、
   HMAC GitHub webhook ingressを公開する。operator APIはbearer auth、create/retryは`Idempotency-Key`、
   update/disableは`If-Match`を要求し、commandと監査を同じtransactionへ保存する。任意command、host path、
   credentialをRegistration configurationとして受け付けない。
   status queryはcomponent freshnessに加え、直近job failureとdelivery identity/reason/attemptsを同じ
   repeatable-read snapshotから返し、retry commandの対象を曖昧にしない。retry拒否も固有attemptIdとauditを持つ。
3. supervisorはPostgreSQLの全Registrationを周期取得し、enabled/versionに応じてIssue monitor、PR monitor、
   checksum固定の`gh-webhook`を用いた`gh webhook forward` adapterを個別に起動・停止・再起動する。childへ渡す
   environmentはGitHub auth/transport allowlistだけとし、control-plane secretを継承しない。DB取得またはactual-state
   書込失敗時は既存componentと未起動placeholderを全停止する。
   process restart後はDBだけから再構成する。
4. webhookはsignature/repository/eventを検証してdeliveryをcommitした後だけACKする。routerは期限付きclaim、
   retry/backoff、ignored reason、auditを永続化し、unknown/disabled/stale/capability-disabled/execution-disabledを
   fail closedにする。pollはrepositoryの現在のOpen Issue/PRを発見し、同じlogical work idempotency keyへenqueueする。
5. `LISTEN/NOTIFY`はwake hintに限定し、supervisor/routerのperiodic reconciliationを必須のtruth recoveryとして残す。
   LISTEN切断はbackoff再接続し、通知欠落だけではworkを失わない。
6. PR #9のregistry/router/forwarder/poll behaviorはdeterministic regression testとTypeScript compatibility oracleから
   Goへ移す。旧JSON control storeへfallback/dual-writeせず、evaluation-domain JSONの契約とデータは変更しない。
7. Control API contractはpinned `designflow@contract-v1.0.0-rc.1` bundleのhuman decision、revisionId、
   bundleDigest、artifact digest、ambiguity、Capability fields、API/system/Issue AC coverageが完全一致した場合だけ採用する。
   mismatch、mixed revision、unapproved、incomplete inputを起動時に拒否する。

## 帰結

- Registration変更はdaemon再起動なしで対象componentへ収束し、desiredとactualの乖離をAPIで観測できる。
- PostgreSQL切断中に新しいexecutionを始めず、復旧後は同じprocessのperiodic pathから再構成できる。
- webhook即時性とpoll回復性は、DB unique/idempotency制約を共有するため二重実行にならない。
- control planeの唯一のdurable SoT、internal-only PostgreSQL/runner、loopback-only control publishという
  CISO-01/02不変条件を維持する。
- provider bundle更新やCapability変更には、新しいapproved revision/digestとcoverage evidenceが必要になる。

## 実装先 id

- architecture: `ARCH-registration-control-001`〜`008`
- domain-model: `DOM-registration-control-001`〜`006`
- data-model: `DATA-registration-control-001`〜`007`
- ubiquitous-language: `LANG-registration-control-001`〜`010`
