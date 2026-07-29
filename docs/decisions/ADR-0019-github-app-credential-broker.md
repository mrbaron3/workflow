# ADR-0019: GitHub App credential brokerで手動PATと共有`gh` credentialを廃止する

- 状態: 採択・実装済み
- 所有 Issue: [#46](https://github.com/mrbaron3/workflow/issues/46)
- 関連: [ADR-0015](ADR-0015-postgresql-fenced-isolated-runner.md)、
  [ADR-0017](ADR-0017-private-repository-monitor-broker.md)

## 文脈

triageはIssueのread/writeだけ、development runnerはbranch／PR／check／mergeに必要な権限だけを必要とする。
operatorの`gh auth`をcontainerへ共有すると、そのcredentialのrepository・organization権限まで渡る。
fine-grained PATをroleごとに作る方式でも、有効期限更新、repository追加、scope確認のたびに人間がtokenを作成・
配布する必要があり、期限切れと過剰権限が通常運転へ混入する。

GitHub CLIのログインcredentialはGitHub App installation tokenをmintする権限源ではない。GitHub Appの秘密鍵と
installation identityだけが、repositoryとpermissionを毎回狭めた短期tokenを発行できる。この秘密鍵を
triage／runnerへ渡すと両roleが任意scopeをmintできるため、専用broker境界が必要になる。

## 決定

1. 一つのGitHub Appを対象ownerへinstallする。installationのrepository selectionは
   `AGENTOPS_MONITOR_REPOSITORIES`のexact集合とし、App自体には次のunionだけを許可する。
   `Actions: read`、`Checks: read`、`Contents: write`、`Issues: write`、
   `Pull requests: write`、`Commit statuses: read`、`Workflows: write`。
   administration、members、secrets、packages、deployments、organization権限、webhookは付与しない。
2. `agentops-github-broker`だけがApp秘密鍵を読む。hostのmode `0600`以下の単一PEMをstdinで
   `agentops-*-github-app-key` named volumeへseedし、brokerへread-only mountする。host path、PEM、
   JWT、installation tokenをargv、container label、spec digest、log、status、evidence、PostgreSQLへ残さない。
   brokerはpublic host portを持たず、default networkでGitHubへ出て、internal networkでworkerからだけ受ける。
3. brokerは起動時に`GET /app`とinstallation identityを検証し、全role tokenを実際にmintしてからreadyになる。
   token requestにはexact repository名とpermission mapを毎回指定し、応答permissionと
   `/installation/repositories`のexact集合を再検証する。tokenは最大15分cacheし、有効期限10分前までに
   自動refreshする。GitHubのinstallation token有効期限は約1時間であり、永続化しない。
4. role別の実効scopeは次のとおり。

   | mode / role | repositories | installation token permissions |
   | --- | --- | --- |
   | `MONITOR_ONLY` triage | monitor allowlist | Contents read、Issues read、Pull requests read |
   | `ACTIVE` triage | monitor allowlist | Contents read、Issues write、Pull requests read |
   | `ACTIVE` runner | `AGENTOPS_RUNNER_REPOSITORIES` | Actions read、Checks read、Contents write、Issues write、Pull requests write、Commit statuses read、Workflows write |

   runner集合はmonitor集合のsubsetでなければならない。全repositoryは同じinstallation ownerに属する。
5. clientはGitHub tokenを保持しない。triage／runnerの別DB passwordからdomain-separated HMACで導出した
   role capabilityだけを受け、`gh` wrapperまたはGit askpassが各operation直前にbrokerへtokenを要求する。
   wrapperはreal `gh`へtokenを渡す直前にbroker URL／role／capabilityを環境から除く。AI provider、
   tmux session、grader、credentialなしのgit commandからもcapabilityとaskpassを除く。
6. `GH_TOKEN`、`GITHUB_TOKEN`、`AGENTOPS_{CONTROL,TRIAGE,RUNNER}_GITHUB_TOKEN`が起動環境にあれば
   fail closedする。移行用fallbackやPAT優先順位は設けない。controlは引き続きGitHub credentialを持たない。
7. request／responseは
   `contracts/github-credential/v1/{token-request,token-response}.schema.json`でversion固定する。
   role capabilityは別roleへ利用できず、unknown field、oversized body、role mismatch、scope drift、
   permission drift、期限異常を拒否する。

## 帰結

- 通常のtoken期限更新に人間操作は不要になる。App作成／installation、repository selectionまたはApp permissionの
  拡張、秘密鍵失効だけがGitHub側の管理操作である。既存のsigned-in browser sessionがあればCodexがこの一回限りの
  setupも実施できるが、GitHubのpassword／2FA／organization approvalはsecurity boundaryとして代行不能な場合がある。
- `gh auth`はdeveloper CLIの操作には使えても、このruntimeのcredential sourceにはならない。
- DB role password rotationはrole capabilityも同時にrotationし、`agentopsctl start`がbrokerとworkerを同じdesired
  specへ置換する。
- App permission unionを広げる変更とrunner repository追加はsecurity review対象である。token発行時のsubset指定が
  App installation自体の過剰権限を正当化するものではない。
