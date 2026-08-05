# Design delta

- `apps/agentops/src/domain/schema.ts`へ`PrRevision`、`PR.currentRevisionId/headSha`、
  `EvalRun/AgentInvocation.revisionId/headSha`を追加する。
- `observePrRevision`をrevision identityとstale invalidationの単一writerにする。
- 既存recordはnullable defaultで読み、backfill推測をしない。
