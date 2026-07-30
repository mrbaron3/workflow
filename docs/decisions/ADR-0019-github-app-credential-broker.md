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
   brokerはpublic host portを publish せず、default networkでGitHubへ出て、`0.0.0.0:8083`でlistenする。
   到達できるのは同じnetworkに接続したcontainerだけで、hostとhost外からは到達しない。default network上の
   他containerからも到達し得るため、到達制御ではなくrole capabilityの検証が認可の実体である。broker自身の
   containerはclient capabilityを持たない（readiness probeは無認証の`/healthz`）。
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
   `DRAINING`は`ACTIVE`と同一のrole policyを持つ。DRAININGは`ACTIVE`からしか到達せず、drain中のrunnerは
   与えられたattemptをpush／closeし切る必要があるため、brokerはDRAININGでも起動して同じscopeを供給する。
   起動を拒むとcompensationがrestoreしたはずのbrokerを失い、drain中のrunnerがcredential sourceを失う。
   DRAININGでscopeを広げることはしない。
5. clientはGitHub tokenを保持しない。role capabilityだけを受け、`gh` wrapperまたはGit askpassが
   各operation直前にbrokerへtokenを要求する。capabilityは`AGENTOPS_GITHUB_BROKER_{TRIAGE,RUNNER}_CAPABILITY`
   が供給する**独立したsecret**（43..128のURL-safe文字）であり、他のcredentialから導出しない・他のcredentialと
   同値にしない。capabilityの保持はそのroleのinstallation tokenをmintする権利そのものなので、PostgreSQL role
   passwordなど別のtrust domainの秘密からdomain-separated HMACで導出すると、そのdomainの読み手全員が
   GitHub書き込み権を得てしまい、単独失効もできない。
   独立したsecretの**供給元はoperatorの手登録ではなく`agentopsctl`自身の生成**である。両env varが未設定なら、
   `agentopsctl`はrole別に32 byteのCSPRNG値（RawURLEncodingで43文字）を生成し、
   `${AGENTOPSCTL_STATE_DIR:-~/.agentops}/<prefix>/broker-capabilities.json`（mode 0600・親directoryは
   mode 0700）へversion付きで保存する。以後のcommandは同じ値を読み戻すので、bootstrapはoperator入力ゼロで
   済みながらrunning topologyがdesired specと一致し続ける。store作成はatomicかつ**exclusive**（既存があれば
   linkが失敗し、負けたcommandは自分が生成した値を捨てて永続化済みの値を採る）なので、`start`と`status`が
   同時にbootstrapしても両者は同一pairへ収束する。上書きは行わない。storeをnamed volumeではなくhostに置くのは、
   `agentopsctl`自身がbroker／triage／runnerのspecへ注入し、drift比較でも突き合わせる値だからである。
   volumeへ隠すとcommandごとにcontainer execでsecretをstdoutへ流すことになり露出面が増える。
   storeがgroup／world accessible、親directoryが同様（directoryへの書き込み権はstore差し替え権と等価）、
   store／親directoryが別accountの所有、親directoryがsymlink、version不一致、読めない内容、両role同値の
   いずれかなら、**再生成せずに拒否する**。modeは修復できても差し替えられた値は信用を回復できないからである。
   所有者検証はmode bitがaccessを決めなくなる場合の担保である（特権実行の`agentopsctl`は任意directoryを
   traverseでき、ACLはmodeが表現しない権限を与え得る）。`chown`できるのはrootだけなので、state directoryの
   祖先へ書ける principal はdirectoryを差し替えられても所有者は偽装できない。祖先を辿って検証する代わりに
   所有者を見るのはこのためである。両env varを設定した場合は外部secret managerが正本となり、
   storeは書かれない。rotationは`OFF`中にstoreを削除して次のstartで再生成させる（両roleが同時に更新される）か、
   単独roleだけ更新するなら`OFF`中に新しい値をexportする。
   wrapperはreal `gh`へtokenを渡す直前にbroker URL／role／capabilityを環境から除く。AI provider、
   tmux session、grader、credentialなしのgit commandからもcapabilityとaskpassを除く。
   Git askpassはpromptを全文で構造照合し、`https://github.com`宛のusername／password要求だけに答える。
   認識できないprompt・他host宛のpromptにはtokenを出さずに失敗する。
6. `GH_TOKEN`、`GITHUB_TOKEN`、`AGENTOPS_{CONTROL,TRIAGE,RUNNER}_GITHUB_TOKEN`が起動環境にあれば
   fail closedする。移行用fallbackやPAT優先順位は設けない。controlは引き続きGitHub credentialを持たない。
7. request／responseは
   `contracts/github-credential/v1/{token-request,token-response}.schema.json`でversion固定する。
   role capabilityは別roleへ利用できず、unknown field、oversized body、role mismatch、scope drift、
   permission drift、期限異常を拒否する。schemaはissuerが実際にmintしたresponseで検証し、
   runtime validationとschemaが同じcredentialを拒否することもtestで固定する（契約と実装を離さない）。
8. consumerはactor identityを別途configureしない。brokerが起動時にGitHubへ照合したApp identityを
   token responseの`actorLogin`として返し、triageはcredential helperの`actor`操作で読む。tokenは
   helper processの外へ出ない。

## 帰結

- 通常のtoken期限更新に人間操作は不要になる。App作成／installation、repository selectionまたはApp permissionの
  拡張、秘密鍵失効だけがGitHub側の管理操作である。既存のsigned-in browser sessionがあればCodexがこの一回限りの
  setupも実施できるが、GitHubのpassword／2FA／organization approvalはsecurity boundaryとして代行不能な場合がある。
- `gh auth`はdeveloper CLIの操作には使えても、このruntimeのcredential sourceにはならない。
- role capabilityはDB role passwordから独立して単独でrotationできる。`OFF`中にstoreを削除するか新しい値を
  exportして`agentopsctl start`すれば、brokerとworkerが同じdesired specへ置換される。逆にDB password
  rotationはcapabilityへ波及しない。
- capability bootstrapはoperator手順から外れる代わりに、`agentopsctl`を動かすhost accountの保護が
  capabilityの保護になる。そのaccountを取れる主体はstoreを読める。tokenを持たせないclient境界は変わらないが、
  信頼の置き場所がoperatorのsecret管理からhost accountへ移ることは明示的な受容事項である。
- App permission unionを広げる変更とrunner repository追加はsecurity review対象である。token発行時のsubset指定が
  App installation自体の過剰権限を正当化するものではない。
