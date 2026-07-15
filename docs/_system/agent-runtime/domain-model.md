# ドメインモデル — agent-runtime コンテキスト

> 語彙は [ubiquitous-language.md](ubiquitous-language.md) を参照する。追加のみ。

## エンティティ／値オブジェクト

- **DOM-agent-runtime-001 AgentInvocation** — 集約ルート。identity=`LANG-agent-runtime-002`、所有:
  role / perspective / provider / model / prompt / outcome / timestamps。1 logical identityにつき最大1 record。
- **DOM-agent-runtime-002 InvocationIdentity** — subjectId・issueId/PR・sampleIndex・attempt・role・perspectiveから
  作るimmutable value object。provider/modelはrouteのprovenanceでありidentity自体には含めない。
- **DOM-agent-runtime-003 ProviderRoute** — `(role, perspective?) → (provider, model?)` の値オブジェクト。
  同じInvocationIdentityを異なるrouteで上書きできない。
- **DOM-agent-runtime-004 ProviderAdapter** — Providerごとのsession実装。共通requestを受け、共通outcomeと
  evidence sentinelを返す。storeやpanel verdictを所有しない。

## 不変条件

- **DOM-agent-runtime-005 provenance completeness** — 実sessionを発行した呼出しはproviderを必ず持つ。
  model未指定はnull、perspective無しはnullとして未知と不在を保つ。promptとoutcomeを省略しない。
- **DOM-agent-runtime-006 idempotent identity** — 同一InvocationIdentityの同一provenance再記録は同じrecordを返す。
  provider/model/prompt/role/perspectiveが違う再記録はconflictとしてfail-closedに拒否する。
- **DOM-agent-runtime-007 evaluation linkage** — 非決定reviewerが生んだEvalRunは、そのPerspectiveの
  AgentInvocation identityを参照する。generator attributionでreviewer providerを代用しない。
- **DOM-agent-runtime-008 adapter fidelity** — ProviderAdapterは共通requestのpurpose・model・追加writable root・
  approval-free interactive実行をprovider固有flagへ完全に写す。未登録providerを別providerへfallbackしない。
- **DOM-agent-runtime-009 route precedence** — reviewerは`perspective route > reviewer default > legacy reviewer model +
  Claude provider`、generatorは`generator route > legacy config.generator/models.generator`で一意に解決する。
  UI designerは`uiDesign route > planning route > legacy generator route`、planningは`planning route > legacy generator route`。
  同じconfig/role/perspectiveは同じProviderRouteになり、session内判断で変化しない。
