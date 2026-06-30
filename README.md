# AgentOps — coding-agent development & eval harness

A **local-first operating harness** that runs existing coding agents (Claude Code /
Codex / Gemini) through a real development organisation's loop: **Roadmap → Issue
Contract → Generator PR → Evaluator Scorecard → Repair → Release → Eval-curation →
Dashboard → harness improvement.**

The bet (from the design brief): the leverage is **not more agents** — it's turning
"planning / implementation / review / QA / release / retro / eval-improvement" into
**machine-readable contracts and a measurable eval loop**, with state that lives in a
durable store you can resume, analyse and improve from.

> This is an **MVP**: the entire pipeline runs end-to-end **today, offline**, on a
> deterministic **mock** agent backend. Swapping in a real agent CLI or a GitHub
> backend are isolated, documented seams (see [Wiring real agents](#wiring-real-agents)
> and [docs/ROADMAP.md](docs/ROADMAP.md)).

---

## 日本語概要

これは「コーディングエージェントを束ねて、ロードマップ→Issue Contract→PR→評価→修正→
リリース→評価ハーネス改善まで回す **ローカルファーストな開発運用ハーネス**」の MVP です。
設計ドキュメントの section 18 が言う「まず通すべき 1 本」

```text
Issue Contract → Generator PR → Evaluator Scorecard → Repair → PASS → Eval Result DB
```

を実際に動く形にし、その周りに Roadmap / 複数サンプル(pass@k / pass^k)/ ダッシュボード /
Eval Curator / Harness Analyst を薄く一通り載せてあります。

エージェント実行は既定で **mock**(オフライン・決定論的)なので、すぐ動かせます。

```bash
npm install
npm run demo        # 全工程を一気に実行（init→plan→run→curate→analyze→dashboard）
npm run dashboard   # .harness/dashboard.html をブラウザで開く
```

実エージェント(Claude Code / Codex / Gemini)や GitHub 連携への差し替えは
[Wiring real agents](#wiring-real-agents) と [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

---

## Quick start

```bash
npm install
npm run demo            # runs the whole loop on the sample roadmap
npm run dashboard       # opens .harness/dashboard.html
```

Or drive it step by step (`agentops` == `npm run harness --`):

```bash
npm run harness -- init
npm run harness -- plan-roadmap          # ingest seed/sample-plan.yaml into the planning tree
npm run harness -- spawn-specs           # materialize one authorable spec stub per feature
npm run harness -- plan-tree             # print roadmap → epic → feature → spec
npm run harness -- plan                  # LEGACY: ingest seed/sample-roadmap.yaml (drives the demo)
npm run harness -- run                   # Generate → Evaluate → Repair → Release
npm run harness -- status                # pass@k / pass^k / cost
npm run harness -- curate                # promote blocker criteria into the eval registry
npm run harness -- analyze --create      # file harness/eval improvement issues
npm run harness -- dashboard --open
```

## The loop

```text
 Roadmap ─▶ Epic ─▶ Issue Contract ─▶ Coordinator
                                          │
                          ┌───────────────┴───────────────┐
                          ▼            (per issue: N samples)
                     Generator ──▶ PR ──▶ Evaluator ──▶ Scorecard
                          ▲                                │
                          │   request_changes              │ approve
                     Repair Router ◀──────────────────────┤
                                                           ▼
                                                    Release Manager ─▶ released
                                                           │
   Eval Curator ◀── failures ── Eval Result DB ◀───────────┘
        │                            │
        ▼                            ▼
  Eval Task Registry            Dashboard ─▶ Harness Analyst ─▶ type:harness / type:eval issues
```

Each issue is run as **N independent best-of-N samples**; each sample has its own
bounded **repair loop**. Running every sample to completion is what makes **pass@k**
(any sample passes — exploration) and **pass^k** (all samples pass — consistency)
both measurable for the same issue.

## What you get from a run

- `.harness/db.json` — the **Eval Result DB** / source of truth (issues, PRs, eval runs).
- `.harness/evidence/<run>/` — per-eval evidence: `scorecard.yaml`, `trace.txt`,
  `artifact.json`, and a placeholder `screenshot.svg` for UI checks. **A verdict never
  ships without evidence.**
- `.harness/dashboard.html` — roadmap/epic progress, pass@k vs pass^k curve, the
  **area × failure-type heatmap**, per-agent stats, and recent scorecards with links.

## Repository layout

```text
agents/            role prompts (the real prompts you'd feed an agent)
templates/         issue-contract.md, scorecard.yaml, labels.yaml, epic.md, roadmap.yaml
seed/              sample-roadmap.yaml — drives the demo
src/
  domain/          zod contracts (schema.ts) + state machine (states.ts) + artifact types
  store/           the JSON-backed Eval Result DB (store.ts)
  agents/          AgentRunner: mock.ts (default) + cli.ts (real CLI adapter)
  graders/         hard gates + composite score (index.ts)
  pipeline/        evaluate · repair · coordinator · curator · analyst
  metrics/         pass@1 / pass@k / pass^k / heatmap / cost (metrics.ts)
  planning/        planning tree: roadmap→epic→feature→spec (planning-tree.ts) + legacy seed (planner.ts)
  dashboard/       self-contained HTML + terminal status report
  cli/             the agentops command
test/              vitest: schema, grader, metrics, end-to-end pipeline
docs/              context-map.md · _system/<ctx>/ · decisions/ (ADR) · ROADMAP.md
```

## Concepts (mapped to the brief)

| Concept | Where | Notes |
| --- | --- | --- |
| Planning tree | `src/planning/planning-tree.ts`, `Feature` schema | roadmap→epic→feature→spec; planner emits outcomes, AC are never inlined (`docs/specs/planning-tree/`) |
| Issue Contract | `templates/issue-contract.md`, `IssueContract` schema | a contract is "ready" only when it parses |
| State machine | `src/domain/states.ts`, `templates/labels.yaml` | `status:*` labels = the lifecycle |
| Generator / Evaluator / Repair | `agents/*.md`, `src/pipeline/*` | Evaluator is independent; verdict from evidence |
| Hard gates then score | `src/graders/index.ts` | any blocker fails ⇒ `request_changes`, regardless of score |
| Scorecard + evidence | `src/pipeline/evaluate.ts`, `.harness/evidence/` | matches `templates/scorecard.yaml` |
| pass@k vs pass^k | `src/metrics/metrics.ts` | unbiased estimators; both reported |
| Eval Task Registry | `src/pipeline/curator.ts` | grows regressions from real failures |
| Harness self-improvement | `src/pipeline/analyst.ts` | files `type:harness` / `type:eval` issues |

See [docs/context-map.md](docs/context-map.md) for the bounded contexts and where each
term lives (terminology is per-context under `docs/specs/_system/<ctx>/ubiquitous-language.md`).

## Wiring real agents

Set the backend in `.harness/config.json`:

```jsonc
{
  "generator": "claude",         // "mock" | "claude" | "codex" | "gemini"
  "samples": 3,
  "maxRepairs": 2,
  "passThreshold": 0.7,
  "cli": {
    "claude": { "command": "claude", "args": ["-p", "{prompt}"] },
    "codex":  { "command": "codex",  "args": ["exec", "{prompt}"] },
    "gemini": { "command": "gemini", "args": ["-p", "{prompt}"] }
  }
}
```

…or override per run: `npm run harness -- run --agent claude --samples 5`.

The CLI runner renders `agents/generator.md` + the Issue Contract, invokes the tool,
and parses a `BuildArtifact` JSON block from its output (the output contract is
documented in `agents/generator.md`). **Honest MVP boundary:** full-fidelity real-agent
runs need the agent to operate on an actual target repo and the graders to run real
commands (`npm test`, Playwright, …) against that checkout — that target-repo wiring is
the v2 step in [docs/ROADMAP.md](docs/ROADMAP.md). Until then the deterministic mock is
what makes the loop testable and reproducible.

## What is real vs mocked (so there are no surprises)

- **Real:** the contracts & schema validation, the state machine, the store/Eval DB,
  the grader gate logic & scoring, scorecards & evidence, the metrics (pass@k/pass^k,
  heatmap, cost), curation, analysis, the dashboard, the CLI.
- **Mocked:** the agent *execution* (deterministic simulation) and therefore the graders
  inspect a described artifact rather than a live checkout. Cost/tokens are synthesised.

## Develop

```bash
npm run typecheck
npm run test
```
