# Architecture

> 本書の `status: contract-drafted` 等の旧ラベル、`agents/issue-planner.md` 単独の Planning layer、
> `any approved ? release` は新設計で更新済み（status は二段ライフサイクル + `build-approved`/`ready-to-release`
> に改名、Planning は M21 Design Planner + M05 resolve に分割、本番 merge は人間ゲート）。実装が追従するまでの
> 参考として残す。

## Layers

```text
Product layer     Roadmap, Epics, release goals            domain/schema.ts, planning/
Planning layer    Issue Contracts, acceptance criteria     domain/schema.ts, agents/issue-planner.md
Execution layer   agent assignment, samples, PRs           agents/runner.ts, pipeline/coordinator.ts
Evaluation layer  graders, scorecards, evidence            graders/, pipeline/evaluate.ts
Learning layer    metrics, dashboard, eval growth          metrics/, dashboard/, pipeline/curator.ts, analyst.ts
```

## Data flow (one issue)

```text
plan ──► Issue{status: contract-drafted, contract}
   │
coordinator.runIssue
   │  for s in 0..samples-1:
   │    PR{branch per sample}
   │    for attempt in 1..maxRepairs+1:
   │       runner.generate(contract, repairBrief?) ─► BuildArtifact
   │       evaluate(): gradeBuild() ─► EvalRun(scorecard) + evidence files
   │       approve ? break : repairBrief = buildRepairBrief(run)
   │  any approved ? release : escalate(needs-human-review)
   ▼
store.save()  ─►  .harness/db.json (+ evidence tree)
```

The **store is the source of truth.** A process can die after any step and the next
`run`/`status`/`dashboard` reads the same JSON and continues — exactly the property the
brief insists on ("state lives in Issues/PRs/Eval Runs, not in a tmux pane").

## Key design choices

- **Contracts are zod schemas** (`domain/schema.ts`). Every cross-agent artifact is
  validated on the way in and out of the store. A malformed contract or scorecard fails
  loudly rather than silently corrupting the loop.
- **Hard gates before score** (`graders/index.ts`). Any blocker failure ⇒
  `request_changes` regardless of the composite score — you cannot "average away" a
  broken blocker.
- **Determinism by construction** (`util/hash.ts`). The mock derives every decision from
  a string seed, never `Math.random()`. Same inputs ⇒ same scorecard ⇒ trustworthy
  pass@k/pass^k and a reproducible demo (see `test/pipeline.test.ts`).
- **Pluggable backend** (`agents/runner.ts`). The pipeline depends only on the
  `AgentRunner` interface; `mock` and `cli` are interchangeable.

## Extension seams (where to grow it)

| Want to… | Change only… |
| --- | --- |
| Run a real agent | `config.generator` + `agents/cli.ts` (+ a target repo, see ROADMAP v2) |
| Back state with GitHub | `store/store.ts` — replace JSON read/save with Issues/PRs/labels API |
| Add a real grader | `graders/index.ts` — run `npm test` / Playwright against a checkout |
| Add a reviewer persona | a new `agents/*.md` + invoke it in `pipeline/evaluate.ts` |
| Add a metric / panel | `metrics/metrics.ts` + `dashboard/dashboard.ts` |

## Why JSON, not SQLite

For an MVP the db is small, and a single inspectable/diffable JSON document is the most
debuggable source of truth. `store.ts` is a thin repository, so moving to SQLite or a
GitHub backend later is a localized change.
