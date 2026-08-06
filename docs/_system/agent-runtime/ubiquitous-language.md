# ユビキタス言語 — agent-runtime コンテキスト

> agent-runtime は、planning / UI-design / generation / review が利用する非決定なAI呼出しを、provider固有CLIから
> 独立した共通言語へ翻訳する。executionのqueue・liveness・fan-out、evaluationの採点意味論は所有しない。
> 追加のみ（`LANG-agent-runtime-NNN` は安定）。

| ID | 用語 | 意味 |
| --- | --- | --- |
| LANG-agent-runtime-001 | Agent Invocation | 1つのroleが1つのprovider/modelへpromptを発行し、1つのoutcomeを得る監査可能な呼出し単位。 |
| LANG-agent-runtime-002 | Invocation Identity | subject・sample・attempt・role・perspectiveから決定論的に作るlogical identity。同じ仕事のresumeを重複recordにしない。 |
| LANG-agent-runtime-003 | Provider | Claude Code / Codex / Gemini / mock等、sessionを実際に遂行するtool family。modelとは別軸。正典型名は`AgentProvider`で、role別aliasを新設しない。旧`GeneratorAgent` aliasは削除済みであり、新しい契約語へ再導入しない。 |
| LANG-agent-runtime-004 | Model | Provider内で選ぶmodel id/alias。未指定はprovider defaultを意味し、unknownを特定modelとして捏造しない。 |
| LANG-agent-runtime-005 | Invocation Role | generator / reviewer / roadmap-planner等、呼出しが負う単一責務。executionのrole-scoped contextと対応する。 |
| LANG-agent-runtime-006 | Perspective Route | reviewer roleをcodeQuality/security等のlensへさらに限定する任意のroute。非reviewerではnull。 |
| LANG-agent-runtime-007 | Provider Adapter | 共通session契約をprovider固有のinteractive CLI起動・tool権限・prompt投入へ翻訳するadapter。 |
| LANG-agent-runtime-008 | Invocation Provenance | role・perspective・provider・model・prompt・outcomeをInvocation Identityへ結び付けた耐久記録。 |
| LANG-agent-runtime-009 | Invocation Key | AI呼出しのlogical identityをevidence間で保持する正典string。`apps/agentops/src/domain/schema.ts`の`AgentInvocation.invocationKey`が正本である。release receiptの現行`invocationId`は`invocation:<deterministic UUID>`として一方向導出した参照で、元keyの別名でも逆写像可能なidentityでもない。次期wireではkeyをadditiveに載せ、派生値は`invocationRef`へ降格する。 |
