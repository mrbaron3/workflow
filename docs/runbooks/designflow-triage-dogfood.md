# Designflowを最初の外部targetとしてtriage／開発する

Tracking: [Workflow #44](https://github.com/mrbaron3/workflow/issues/44)

## 決定

DesignflowをWorkflowの最初のmulti-repository dogfood対象にする。ただし
`mrbaron3/designflow`というrepository名、Issue番号、label名、grader commandはproduction codeへ埋め込まない。
対象はoperator allowlist＋PostgreSQL Registration、labelはpolicy、graderはcheckout済みrepositoryのbounded
metadataから決める。

monitor／triageはdevelopment runnerから分離した専用containerで動かす。一方、このcontainerのcodeは現時点では
別repositoryへ分けない。control-store schema、DB capability、lifecycle、OCI topologyと同じreleaseで互換性を
保つ必要があり、Workflowが所有するconsumer-side concernだからである。独立した運用主体、release cadence、
public protocolが必要になった時だけ抽出する。

```text
GitHub Issue
    │
    ▼
control（GitHub credentialなし）
    │ typed monitor request / identity-only triage job
    ▼
GitHub App broker（秘密鍵を持つ唯一のcontainer、host publishなし）
    │ repository/permission限定・短期token
    ▼
triage container（triage capability、workspace/git/SSHなし）
    │ managed label + marker comment
    │
    └─ exact human ready label
             │ atomic DB promotion
             ▼
development runner（別capability、private workspace、ACTIVEだけ）
```

## Bootstrap

1. operatorのprivate env fileで少なくとも次を設定する。値はshell history、Issue、logへ書かない。

   ```sh
   export AGENTOPS_MONITOR_REPOSITORIES='mrbaron3/workflow,mrbaron3/designflow'
   export AGENTOPS_RUNNER_REPOSITORIES='mrbaron3/designflow'
   export AGENTOPS_GITHUB_APP_ID='<numeric App id>'
   export AGENTOPS_GITHUB_APP_INSTALLATION_ID='<numeric installation id>'
   export AGENTOPS_GITHUB_APP_SLUG='<canonical app slug>'
   export AGENTOPS_GITHUB_APP_OWNER='mrbaron3'
   export AGENTOPS_GITHUB_APP_PRIVATE_KEY_FILE='<absolute mode-0600 .pem path>'
   # broker capabilityは任意。未設定なら`agentopsctl`がrole別に生成し、
   # privateな`~/.agentops/<prefix>/broker-capabilities.json`（mode 0600）へ保存して読み戻す。
   # export AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY='<43..128 URL-safe文字>'
   # export AGENTOPS_GITHUB_BROKER_RUNNER_CAPABILITY='<別の43..128 URL-safe文字>'
   export AGENTOPS_TRIAGE_READY_LABEL='ready'
   export AGENTOPS_TRIAGE_CLAIMED_LABEL='agent-claimed'
   export AGENTOPS_TRIAGE_CANDIDATE_LABEL='ready-candidate'
   export AGENTOPS_TRIAGE_BLOCKED_LABEL='blocked'
   export AGENTOPS_TRIAGE_NEEDS_INFO_LABEL='needs-info'
   export AGENTOPS_TRIAGE_CONTEXT_PATHS_JSON='["README.md","AGENTS.md","docs/NORTH_STAR.md","docs/ROADMAP.md","docs/HANDOFF.md"]'
   ```

   `GH_TOKEN`、`GITHUB_TOKEN`、`AGENTOPS_{CONTROL,TRIAGE,RUNNER}_GITHUB_TOKEN`は設定しない。
   role capabilityは他のcredentialから導出せず、他のcredentialと同値にもしない（`agentopsctl`が拒否する）。
   生成されたstoreはoperatorが読み書きしない。rotationは`OFF`中にstoreを削除して次のstartで再生成させる。
   AppはWorkflowとDesignflowだけへinstallし、permission union／role別token subsetは
   [ADR-0019](../decisions/ADR-0019-github-app-credential-broker.md)に固定する。
   4つのDB password、control token、Dashboard bootstrap token、webhook secretも
   [credential runbook](ciso-07-credential-bootstrap-and-rotation.md)どおり別値にする。

2. observation-onlyで起動する。

   ```sh
   go run ./cmd/agentopsctl start \
     --mode MONITOR_ONLY --build --request-id designflow-monitor-bootstrap-001
   ```

   このmodeではIssue/PR identityの観測だけを行う。AI classification、label/comment mutation、
   development runner、provider credentialは存在しない。freshnessは更新するがprocessing cursorは
   進めないため、ここで発見した既存IssueもACTIVE最初のpollで再読される。

3. Dashboard、または同じ意味のControl APIでDesignflow Registrationを作る。APIを使う場合はcredentialを
   argvへ置かずstdin configで渡す。

   ```sh
   curl --silent --show-error --fail-with-body --config - <<EOF
   url = "http://127.0.0.1:8080/v1/registrations"
   request = "POST"
   header = "Authorization: Bearer ${AGENTOPS_CONTROL_TOKEN}"
   header = "Idempotency-Key: designflow-registration-001"
   header = "Content-Type: application/json"
   data = "{\"repository\":\"mrbaron3/designflow\",\"enabled\":true,\"issueMonitorEnabled\":true,\"prMonitorEnabled\":true,\"executionEnabled\":true}"
   EOF
   ```

   allowlistだけ、またはRegistrationだけでは観測されない。両方の一致が必要。

4. Dashboardでrepository、monitor freshness、queue、last failureを確認してから`ACTIVE`へ進める。
   ACTIVEではprovider credentialも必要になる。

   ```sh
   go run ./cmd/agentopsctl start \
     --mode ACTIVE --request-id designflow-active-001
   ```

## 最初に流すIssue

最初のheadless縦断候補はDesignflowのDF-006（AuthoringBackend port、現在のroadmap上はIssue #4）。
UI lifecycleを前提にせず、公開contractと`node scripts/check-contracts.mjs`で判定でき、次のDF-007
provider adapterを解放するためである。Issue番号は運用時点の情報であり、code/testには固定しない。

AI triageが`ready-candidate`を付けても開発は始まらない。依存、WHAT、受入境界を人間が確認し、
実装開始を意図した場合だけexact `ready` labelを付ける。development runnerはpromotion payload内の
configured ready／claimed labelを使い、Designflow専用分岐なしにIssueをclaimする。

Designflowは`package.json`のdirect Node contract checkerからgrader profileを選ぶ。repository名で
graderを分岐せず、shell operator、package install、job-supplied commandは拒否する。UIを持つDF-005では、
headless contract testの後に最小のheaded browser／assistive-technology確認を別証拠として追加する。

## Codex asset／Claude Designの役割指定

意図するpolicyは次のとおり。

- Codex asset route: raster asset、illustration、texture等を生成し、artifact URI／digest／size／provenanceを返す。
- Claude Design route: design token、component、pattern、state、interaction、accessibility ruleと
  Design System Deltaを所有する。
- Experience／Design Bundleは両出力をversioned contractで合流し、人間承認をimmutable revision digestへ束縛する。
- providerはready approval、consumer Issue lifecycle、endpoint／table設計を所有しない。

この分担はDesignflowの公開`AuthoringBackend` contract/policyとして指定し、repository名条件やpromptだけの慣習に
しない。現在のlegacy harnessは`.agentops.json`のrole routeでCodex／Claudeを分けられるが、isolated production
runnerは1回のjobで単一providerを全roleへ配る。したがって上記の二provider分担はまだproduction縦断の完了条件を
満たしていない。Workflow側Issueで、job contractに任意commandやcredentialを追加せずrole→provider policyを
Registration-owned configurationとして渡す変更を追跡する。

## 合格条件

- 任意の2 repositoryを同時allowlist／Registrationへ置き、brokerが混同せず観測する。
- Issue本文中の命令を実行せず、strict triage decisionとmanaged label/commentだけを作る。
- AIは`ready`を付けられず、人間のexact label後だけdevelopment jobがatomicに作られる。
- triage containerにworkspace、git／SSH、runner capability、control token、host port/socketがない。
- App秘密鍵はbrokerだけにread-only mountされ、triage／runner／controlから読めない。
- Designflowのdirect Node contract checkerをrepository名分岐なしで実行する。
- 最後にlive GitHub上でclaim→PR→current-head review→required check→expected-head merge→Issue closeを1件通す。
