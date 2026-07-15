# Role and perspective agent routing 受け入れ要件

## 意図

- 機能: Role and perspective agent routing
- outcome: generator/planningと各review perspectiveに(provider, model)を決定論的に割り当て、未設定時の既定・
  無効routeのfail-closed・再実行時の同一routeが監査可能に成立する。
- 計画の木リンク: feature=FEAT-015 epic=EPIC-07

## 受け入れ基準

- **[AC-AGROUTE-001] legacy configは従来と同じgenerator/reviewer routeになる**
  - Given routesを持たない既存configがある
  - When generatorとreviewer routeを解決する
  - Then generatorはconfig.generator/models.generator、reviewerはClaude/models.reviewerへ解決される

- **[AC-AGROUTE-002] role default routeを明示上書きできる**
  - Given generator/reviewer/planning routeがconfigにある
  - When各roleを解決する
  - Then各roleは指定providerとnullable modelへ解決され、他roleの設定と混ざらない

- **[AC-AGROUTE-003] Perspective routeはreviewer defaultより優先される**
  - Given reviewer default=Claude、security=Codex、他Perspective未設定のconfig
  - When securityとcodeQualityを解決する
  - Then securityだけCodex route、codeQualityはClaude defaultとなる

- **[AC-AGROUTE-004] 無効routeはsession/store変更前にfail-closedになる**
  - Given provider欠落・未知provider・非文字列modelの選択routeがある
  - When resolverを呼ぶ
  - Then role/perspectiveと理由を含むerrorになり、legacy routeへfallbackしない

- **[AC-AGROUTE-005] generator所有者と実行providerが同じrouteを使う**
  - Given generator routeがlegacy config.generatorと異なる
  - When issueをassign/adoptしpoll guardとlive generatorを実行する
  - Then assignedAgent、poll predicate、PR.generator、AgentInvocation.providerはresolved generator providerで一致する

- **[AC-AGROUTE-006] 混在provider panelがPerspectiveごとのprovenanceを保つ**
  - Given同一panelでClaude/Codexへ分かれるPerspective routesがある
  - When reviewer jobsを準備・完了する
  - Then各sessionは自routeで起動し、AgentInvocationとEvalRun linkageはPerspectiveごとのprovider/modelを保持する

## レッドライン

- reviewer全体を単一model設定へ再び潰さない。
- routeをLLMまたは実行順で選ばない。
- 無効Perspective routeをreviewer defaultへ黙ってfallbackしない。
- assignedAgentと実generator providerを別のresolverで決めない。
- configの解決結果をPromptRecord等へdual-writeしない。
