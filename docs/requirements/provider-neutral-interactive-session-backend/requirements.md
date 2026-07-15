# Provider-neutral interactive session backend 受け入れ要件

## 意図

- 機能: Provider-neutral interactive session backend
- outcome: tmuxの対話・sentinel・liveness契約を保ったまま、Claude Code/Codex等の起動差をprovider adapter
  の内側へ閉じ、executionは特定CLIのcommand形に依存しない。
- 計画の木リンク: feature=FEAT-014 epic=EPIC-07

## 受け入れ基準

- **[AC-AGBACK-001] Claude adapterが共通requestをinteractive commandへ写す**
  - Given provider=claude、purpose、任意model、追加evidence directoryを持つrequest
  - When adapterがlaunch commandを構築する
  - Then Claude固有のname/permission/tool/add-dir/model flagがpurposeどおり設定される

- **[AC-AGBACK-002] Codex adapterが同じ共通requestをinteractive commandへ写す**
  - Given provider=codexの同形request
  - When adapterがlaunch commandを構築する
  - Then Codex固有のworkspace sandbox、approval=never、add-dir、任意model flagが設定され、headless execを使わない

- **[AC-AGBACK-003] executionはproviderを選ぶがCLI flagを組み立てない**
  - Given generator sessionにclaudeまたはcodex providerが渡される
  - When tmux sessionをlaunchする
  - Then executionは共通launch requestを渡し、tmux transportがregistryのadapter commandをそのまま起動する

- **[AC-AGBACK-004] 未登録providerは起動前にfail-closedになる**
  - Given interactive adapter未実装のproviderが指定される
  - When backend registryを解決する
  - Then Claudeその他へfallbackせず、provider名を含むunsupported errorになる

- **[AC-AGBACK-005] providerごとのready検知後も共通sentinel/livenessを使う**
  - Given Claude/Codex interactive TUIが起動する
  - When orchestratorがprompt投入と完了待ちを行う
  - Then adapterのready markerだけがprovider固有で、sendPrompt・monitorLiveness・sentinel path・outcome語彙は共通のままである

- **[AC-AGBACK-006] path/model値をcommand injectionなしに受け渡す**
  - Given spaceまたはquoteを含むmodel/additional directory値がある
  - When commandを構築する
  - Then 値はshell-safeに単一argument化され、追加commandとして解釈されない

## レッドライン

- provider判定をsession.ts/perspective-session.tsのCLI文字列分岐として増やさない。
- Codex指定をClaude起動で代用しない。
- 対話・attach可能性をheadless executionへ置き換えない。
- approval待ちでdetached sessionをstuckさせない。
- D6のreview evidence sidecar・source edit guardを弱めない。
