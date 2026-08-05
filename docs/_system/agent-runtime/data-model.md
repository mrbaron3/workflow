# データモデル — agent-runtime コンテキスト

> 構造化正本は `apps/agentops/src/domain/schema.ts` のZod schemaと `.harness/db.json`。

- **DATA-agent-runtime-001 `AgentInvocation`** — `id`, `invocationKey`, `subjectId`, nullable `issueId`/`prId`/
  `sampleIndex`, `attempt`, `role`, nullable `perspective`, `provider`, nullable `model`, `prompt`, `outcome`,
  `createdAt`。`invocationKey`はlogical unique key。
- **DATA-agent-runtime-002 `DB.agentInvocations`** — additive `default([])` collection。既存DBは空で読める。
  new runtime writesはここだけを正本とする。
- **DATA-agent-runtime-003 legacy `DB.promptRecords`** — DATA-execution-006/007の既存generator監査履歴。
  削除・書換え・暗黙backfillをせずread-only legacyとして残す。新規sessionはAgentInvocationへ記録し、
  2 collectionへdual-writeしない。
- **DATA-agent-runtime-004 `EvalRun.invocationKey`** — nullable additive back-reference。nullはlegacy、
  deterministic grader、またはinvocation記録導入前。非nullは同じPerspectiveのAgentInvocationを指す。
- **DATA-agent-runtime-005 adapter registryは非永続** — provider→adapter対応とready patternはコード上の
  capability registry。availabilityをDBへ推測保存せず、各起動要求時に解決してunsupportedを顕在化する。
- **DATA-agent-runtime-006 `HarnessConfig.routes`** — optional additive config。`generator`/`planning`/`uiDesign`/`reviewer`と
  `perspectives: Record<lens, route>`、route=`{provider, model?}`。DBへ複製せず、解決結果だけをAgentInvocationへ
  provenanceとして保存する。
