# CISO-04 isolated agentops-runner 実装・検証証跡

- Issue: `mrbaron3/workflow#14`
- base: `origin/main@1ad142836cecec0c117e0f1608568bda60e65d3f`
- ADR: `docs/decisions/ADR-0015-postgresql-fenced-isolated-runner.md`
- control schema: version 3（PostgreSQLのみ。evaluation domain JSON schemaは未変更）

## 実装

### Published Language と PostgreSQL

- `contracts/control-store/v1/runner-{job,result,failure}.schema.json` と
  `src/control-store/types.ts` がversion 1のstrict契約を共有する。
- executable payloadはrepository/event/ref/required checks/merge method/artifact referenceだけを持ち、
  command、clone URL、credential、host path、任意env、未知schema/fieldを拒否する。
- migration `0003_isolated_runner.sql` がtyped result/failure、attempt failure、Registration-scoped artifact、
  boundary auditを追加する。artifact本体/test output/credentialはDBへ保存しない。
- lease claimは`FOR UPDATE OF j,r SKIP LOCKED`。claim/provider/push/merge/release直前にlease owner/expiry、
  job、Registration version/enabled/execution_enabledをrow lock下で再検証し、allow/deny理由を同じtransactionへ記録する。
- Go control planeのIssue/PR/push/check観測は、任意webhook payloadを転送せず、strictな
  `agentops.runner` v1 payloadへprojectする。Issueはdevelopment turn、PR/repository eventはbounded reconciliationだけを許す。

### runner と既存 AgentOps adapter

- `src/runner/service.ts` がLISTEN wake＋周期reconciliation、worker thread heartbeat、expiry/reclaim、
  max-attempt付きretry/backoff、drain/restart recoveryを実装する。同期graderでmain event loopが3秒停止しても
  heartbeatは継続し、lease loss後のfinish/retry競合はDBを権威にfail closedとする。
- workspaceはprivate volumeの
  `/workspace/registrations/<registration-id>/jobs/<job-id>/attempt-<n>`へ決定論的に作る。
  clone URLはcanonical repository identityからHTTPSで導出し、job-scoped stateとmirror/worktree/artifactを
  Registration rootへ閉じる。provider/graderはbubblewrap process namespaceでactive Registrationだけを見られる。
- artifactはregular file、Registration一致、real path containment、SHA-256、sizeを実行前に検証する。
  outputはatomic fileとしてvolumeへ書き、DBへURI/digest/size/timeだけをlinkする。
- `ExistingAgentOpsRunnerAdapter`は既存のplanning、UI design、generator、perspective、
  PR-native review/repair/test/current-head required checks/expected-SHA merge/releaseを呼ぶ。
  push/merge/release wrapperはDB guard後の短命・単回permitを実side effect呼出しで消費し、shortcutを持たない。
  Issue jobは他PRをdiscoverせず、PR jobは指定PR番号だけ、repository eventだけがrepository-wide reconciliationを許可する。

### OCI と credential boundary

- standard OCI `runner` stageは既存interactive backendが対応するpinned Codex/Claude CLI、git/gh/tmuxを持つuid 65532のnonroot image。
- 起動時にHOME=`/home/agentops`、cwd=`/app`、唯一のwritable named volume=`/workspace`、zero host ports、
  DB/GitHub/選択providerだけのoutbound集合、Mac HOME/development root/SSH agent/Apple Container socket/control credential
  不在を検証する。
- self-declared設定に加え、Linux kernel mount tableでread-only root/writable `/workspace`/socket・host bind不在を、
  `/proc/net/tcp{,6}`でlistening socket不在を検証する。Apple側inspectもzero published port/socket、
  named volume、read-only root、cap-drop ALLを実測する。
- PostgreSQL pool確立後にprocess envをGitHub＋選択provider credentialへ縮小し、provider/tmux/git子processへ
  database/control credentialを継承しない。Git clone/fetch/pushはHTTPS askpass、providerはprovider tokenのみ、
  repository graderはcredential-free envを受ける。runner DB roleはjob/lease/attempt/artifact/auditだけを変更でき、
  Registration desired state、webhook、control requestを変更・参照できない。

## fastest-first 検証

| 境界 | コマンド | 結果 |
| --- | --- | --- |
| targeted contract/security/workspace/fence/adapter | `npx vitest run ... runner-*.test.ts control-store-contract.test.ts` | 33/33 pass |
| TypeScript full | `npm test` | 97 files pass、1 skip、809 pass、24 skip（PostgreSQL 23 + 既存1） |
| build/typecheck | `npm run typecheck && npm run build` | pass |
| production dependency audit | `npm audit --omit=dev` | 0 vulnerability |
| Go unit | OCI `control-test` build内 `go test ./...` | pass |
| Go race | OCI `go test -race ./...` | pass |
| Go vet | OCI `go vet ./...` | pass |
| PostgreSQL integration | Apple internal network上 `test/control-store.integration.test.ts` | 23/23 pass |
| standard OCI runner | Apple Container `--target runner` | pass、CLI pin/expected-head merge flag検証済み |
| Apple boundary smoke | `npm run smoke:runner:apple` | pass |

Apple smokeのmachine-readable実測は
`evidence/ciso-04/apple-container-smoke.json`、PostgreSQL restart recoveryは
`evidence/ciso-04/postgres-runner-integration.json`、検証一覧は
`evidence/ciso-04/validation.json`を参照する。

## safe path と残余確認

PostgreSQL integrationはlease競合/expiry/restart/stale race/max-attempt/typed outcomeを実DBで通す。
`test/runner-adapter.test.ts`はfake credential・side-effect recorderを用いながら、実
`ExistingAgentOpsRunnerAdapter`のplanning→generator→grounding→全perspective→PR作成→required-check evaluation→
expected-SHA merge→releaseを通す。Apple smokeはinternal networkで外部side effectを禁止したactual runnerへ
unknown schema/tampered artifactを投入し、3秒main-thread block中heartbeat、least-privilege DB role、
bubblewrap sibling Registration非可視も実測する。このため無権限push/mergeは発生しない。実credentialを使うreleaseは
意図的に行わず、production network policy/egress proxyとcredential brokerを含む統合rehearsalを残余リスクとする。
