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

### runner と既存 AgentOps adapter

- `src/runner/service.ts` がLISTEN wake＋周期reconciliation、heartbeat、expiry/reclaim、retry/backoff、
  drain/restart recoveryを実装する。lease loss後のfinish/retry競合はDBを権威にfail closedとする。
- workspaceはprivate volumeの
  `/workspace/registrations/<registration-id>/jobs/<job-id>/attempt-<n>`へ決定論的に作る。
  clone URLはcanonical repository identityからHTTPSで導出し、mirror/worktree/state/artifactをRegistration rootへ閉じる。
- artifactはregular file、Registration一致、real path containment、SHA-256、sizeを実行前に検証する。
  outputはatomic fileとしてvolumeへ書き、DBへURI/digest/size/timeだけをlinkする。
- `ExistingAgentOpsRunnerAdapter`は既存のplanning、UI design、generator、perspective、
  PR-native review/repair/test/current-head required checks/expected-SHA merge/releaseを呼ぶ。
  push/merge/release wrapperはDB guard後の短命・単回permitを実side effect呼出しで消費し、shortcutを持たない。

### OCI と credential boundary

- standard OCI `runner` stageはpinned Codex/Claude/Gemini CLI、git/gh/tmuxを持つuid 65532のnonroot image。
- 起動時にHOME=`/home/agentops`、cwd=`/app`、唯一のwritable named volume=`/workspace`、zero host ports、
  DB/GitHub/選択providerだけのoutbound集合、Mac HOME/development root/SSH agent/Apple Container socket/control credential
  不在を検証する。
- PostgreSQL pool確立後にprocess envをGitHub＋選択provider credentialへ縮小し、provider/tmux/git子processへ
  database/control credentialを継承しない。

## fastest-first 検証

| 境界 | コマンド | 結果 |
| --- | --- | --- |
| targeted contract/security/workspace/fence | `npx vitest run ... runner-*.test.ts control-store-contract.test.ts` | 28/28 pass |
| TypeScript full | `npm test` | 95 files pass、1 skip、797 pass、23 skip（PostgreSQL 22 + 既存1） |
| build/typecheck | `npm run typecheck && npm run build` | pass |
| production dependency audit | `npm audit --omit=dev` | 0 vulnerability |
| Go unit | OCI `control-test` build内 `go test ./...` | pass |
| Go race | OCI `go test -race ./...` | pass |
| Go vet | OCI `go vet ./...` | pass |
| PostgreSQL integration | Apple internal network上 `test/control-store.integration.test.ts` | 22/22 pass |
| standard OCI runner | Apple Container `--target runner` | pass、CLI pin/expected-head merge flag検証済み |
| Apple boundary smoke | `npm run smoke:runner:apple` | pass |

Apple smokeのmachine-readable実測は
`evidence/ciso-04/apple-container-smoke.json`、PostgreSQL restart recoveryは
`evidence/ciso-04/postgres-runner-integration.json`、検証一覧は
`evidence/ciso-04/validation.json`を参照する。

## safe path と残余確認

PostgreSQL integrationはfake credential・fake Git command・side-effect-recording adapterを用い、provider/push/merge/releaseの
全fenceとtyped success/artifact metadataまで通す。Apple smokeはinternal networkで外部side effectを禁止したactual runner
processにunknown schemaとtampered artifactを投入してterminal rejectionを確認する。このため無権限のrepository push/mergeは
発生しない一方、実GitHub/provider credentialを使うend-to-end releaseは意図的に実施しておらず、production network policy/
proxyとcredential brokerを含む統合rehearsalが残余リスクである。
