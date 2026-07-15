# アーキテクチャ — agent-runtime コンテキスト

> provider非依存のportと監査seamのみを定義する。追加のみ。

- **ARCH-agent-runtime-001 invocation identity / recorder** — publicな形:
  `invocationKey(coordinates): string` と `recordAgentInvocation(store, completed): AgentInvocation`。
  recorderはidentityでupsertし、同一provenanceは冪等、相違は書込み前にconflictを返す。
- **ARCH-agent-runtime-002 provider-neutral session port** — publicな形:
  `InteractiveAgentBackend.launch(request): SessionHandle`。requestはproviderに依存しないcwd・role・prompt・
  writable evidence path・tool capability、handleはprompt投入・liveness観測・終了を提供する。
- **ARCH-agent-runtime-003 provider adapter registry** — publicな形:
  `backendFor(provider): InteractiveAgentBackend`。Claude/Codex等のcommand flag差はadapter内部に閉じ、
  未登録providerはfallbackせずfail-closed。
- **ARCH-agent-runtime-004 deterministic route resolver** — publicな形:
  `resolveRoute(config, role, perspective?): ProviderRoute`。優先順位とdefaultをコードで確定し、sessionごとの
  LLM判断へ委ねない。
- **ARCH-agent-runtime-005 execution projection** — generator/reviewer session完了時にexecutionが共通recorderへ
  投影し、reviewerのInvocation Identityを`EvalRun.invocationKey`へ渡す。panelの採点意味論は変更しない。

## 段階導入

- FEAT-013: `ARCH-agent-runtime-001`/`005`（identity・provenance・EvalRun linkage）。
- FEAT-014: `ARCH-agent-runtime-002`/`003`（provider adapter）。
- FEAT-015: `ARCH-agent-runtime-004`（role/perspective route）。

## Route config v1

`config.routes`は`generator`、`planning`、`uiDesign`、`reviewer`、`perspectives.<lens>`に`{provider, model?}`を持つ。
既存configは無変更で同じrouteへ解決される。`config.generator`はgenerator provider、`models.generator`/
`models.reviewer`はlegacy model fallbackとして残る。選択されたrouteのprovider/model型が不正なら、sessionや
storeを変更する前にresolverが拒否する。
`uiDesign`未設定時は独立session/contextを保ったままplanning routeへ、planningも未設定ならlegacy generator routeへ
決定論的にfallbackする。UI Candidateが無いturnではuiDesign route自体を選択しない。

## Provider adapter v1

- `claude`: generator purposeを`Read/Edit/Write/Bash`、reviewer/planner/ui-designer purposeを`Read/Write/Bash`へ写し、
  interactive `acceptEdits`と`--add-dir`を用いる。
- `codex`: purposeをworkspace-write sandbox、approval=never、interactive TUIへ写し、evidence sidecarを
  `--add-dir`で追加する。tmux cwdがworkspace rootなのでprovider commandはrepository pathを再解釈しない。
- `gemini`/`mock`: v1 registry未実装。指定時は起動前に`UnsupportedInteractiveProvider`を返す。
