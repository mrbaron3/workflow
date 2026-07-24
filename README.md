# AgentOps — coding-agent development & eval harness

A **local-first operating harness** that runs existing coding agents (Claude Code /
Codex / Gemini) through a real development organisation's loop: **Roadmap → Issue
Contract → Generator PR → Evaluator Scorecard → Repair → Release → Eval-curation →
Dashboard → harness improvement.**

The bet (from the design brief): the leverage is **not more agents** — it's turning
"planning / implementation / review / QA / release / retro / eval-improvement" into
**machine-readable contracts and a measurable eval loop**, with state that lives in a
durable store you can resume, analyse and improve from.

> This is an **MVP**: the entire pipeline runs end-to-end offline on a deterministic
> **mock** backend. The grounded path adds GitHub Issue intake, provider-routed planning,
> implementation, PR-first isolated review, current-head repair, and expected-SHA automatic
> merge. Its seams are permanently tested;
> a real remote/provider run is still required before claiming environment-level validation.

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

実運用向けには、GitHub の `ready` Issue を取り込み、独立した planning session で契約化し、
Claude Code / Codex を役割・レビュー観点ごとに振り分けて、PR作成後のcurrent-head評価・修正・自動mergeへ
接続する経路もあります。設定例は [GitHub Issue watcher](#github-issue-watcher) を参照してください。

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
term lives (terminology is per-context under `docs/_system/<ctx>/ubiquitous-language.md`).

## Two backends: mock (deterministic) and real (live tmux)

The **mock** backend runs the whole loop offline and deterministically — it is what the test
suite and `agentops run` demo use (`"generator": "mock"`). It is the reproducible substrate:
drive → panel → repair → gate all run without a real agent.

**Real agents run as interactive tmux sessions on an actual git worktree**, grounded by real
`tsc` / `vitest` against that checkout — not a headless `claude -p` shell-out (the old
`CliAgentRunner` was deprecated with the tmux orchestration; headless is a North-Star non-goal,
ADR-0005 Q2). A generator session edits files and commits the build, the GitHub PR is opened, then
read-only perspective sessions review that exact head SHA. A blocker/major finding repairs and
pushes the same branch; a clean current head is merged with an expected-SHA guard. The `store`
gate remains available for local/manual runs.

```bash
npx tsx scripts/real-run-sandbox.ts                  # scaffold a throwaway sandbox + ai-managed issue + config
LENSES=codeQuality npx tsx scripts/real-panel-run.ts # cheap: generator + one review lens
npx tsx scripts/real-panel-run.ts                    # full 6-perspective panel
```

`config.gate.backend` (`store` | `github`) chooses local/manual vs PR-native delivery.
`gate.requiredChecks` names GitHub checks that must be green (empty means all visible checks), and
`gate.mergeMethod` is `squash`, `merge`, or `rebase`. `config.panel.maxConcurrent` bounds the
review fan-out. The execution layer's design lives in
[ADR-0005](docs/decisions/ADR-0005-execution-layer-tmux-orchestration.md) /
[ADR-0006](docs/decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) and the
[`_system/execution`](docs/_system/execution/) views.

## GitHub Issue watcher

The live entry path is:

```text
ready GitHub Issue → durable claim → isolated planning → conditional isolated UI design → trace gate → implementation
→ GitHub PR → current-head isolated perspective reviews → same-branch repair → expected-SHA auto-merge
```

Initialize the harness, then configure `.harness/config.json`. This example routes planning
and general review to Claude, UI design, generation, and the security lens to Codex; every omitted model
inherits the corresponding CLI default.

```json
{
  "generator": "codex",
  "baseBranch": "main",
  "samples": 1,
  "maxConcurrentIssues": 1,
  "maxRepairs": 2,
  "passThreshold": 0.7,
  "scoreWeights": {
    "functionality": 0.4,
    "codeQuality": 0.2,
    "testQuality": 0.15,
    "ux": 0.15,
    "accessibility": 0.1
  },
  "target": {
    "repo": "../target-app",
    "baseRef": "main",
    "systemDir": "../target-app/docs/_system",
    "graders": {
      "typecheck": "npm run typecheck",
      "unit_tests": "npm test",
      "commands": {
        "playwright": "npm run test:e2e",
        "api_test": "npm run test:api"
      }
    }
  },
  "gate": {
    "backend": "github",
    "baseBranch": "main",
    "requiredChecks": ["test"],
    "mergeMethod": "squash"
  },
  "routes": {
    "planning": { "provider": "claude" },
    "uiDesign": { "provider": "codex" },
    "generator": { "provider": "codex" },
    "reviewer": { "provider": "claude" },
    "perspectives": {
      "security": { "provider": "codex" }
    }
  },
  "intake": {
    "backend": "github",
    "repository": "owner/target-app",
    "readyLabel": "ready",
    "claimedLabel": "agent-claimed",
    "pollIntervalMs": 30000
  },
  "panel": { "maxConcurrent": 4 }
}
```

The target must be a git repository, `gh` must already be authenticated, the configured labels
must exist, and each routed provider CLI must be available. Interactive adapters currently exist
for Claude Code and Codex; unsupported providers fail closed. Run one turn or keep watching:

```bash
npm run harness -- poll-intake    # optional: inspect/claim ready input only
npm run harness -- github-turn    # one intake/planning/development turn
npm run harness -- watch-github   # repeat turns; Ctrl-C stops the watcher
```

`intake.pollIntervalMs` is optional and controls the delay between recurring `watch-github`
turns in milliseconds. It does not affect the one-shot `github-turn` command. Valid values are
positive integers up to 2147483647 ms (Node's maximum timer delay); omitted or invalid
values fall back to `DEFAULT_GITHUB_WATCH_INTERVAL_MS` (30000 ms).

### Multi-repository webhook control

Webhook is the immediate trigger; the same daemon also runs polling reconciliation, so a missed,
late, or out-of-order delivery cannot become the source of truth. Start the loopback control plane:

```bash
export AGENTOPS_WEBHOOK_CONTROL_TOKEN='<random local bearer token>'
export AGENTOPS_GITHUB_WEBHOOK_SECRET='<GitHub webhook secret>'
npm run harness -- webhook-daemon --open
```

Both credentials are mandatory and must be non-empty; the daemon refuses to listen if either is
missing. Without `--open`, startup prints a short-lived, single-use browser login URL; with
`--open`, it opens one automatically. The launch establishes an HttpOnly same-site browser session
and immediately redirects to the clean GUI URL; subsequent GUI API calls authenticate through that
session automatically. Scripts may instead send the control token as `Authorization: Bearer …`.
The supervised `gh webhook forward` process receives the same webhook secret used by `/hook` to
verify `X-Hub-Signature-256` before persistence.

The GUI at `http://127.0.0.1:8377` adds/toggles repositories, selects allow-listed events and
consumers, shows each forwarder state and recent durable deliveries, and retries failures.
Registrations and payloads are stored atomically in `.harness/webhooks.json`, separately from the
Eval DB. One `gh webhook forward` child is supervised per enabled repository; this requires the
`gh webhook` extension. Use `--no-forward` when another ingress sends to `/hook`.

The `agentops` consumer runs the fixed `github-turn` entry point—never a registration-supplied
shell command. Each registration's `workspaceRoot` must contain a harness config whose
`intake.repository` matches the registered `owner/name`; separate repositories may therefore use
separate workspaces while sharing this daemon and GUI. The optional `orca-worktree-sync` adapter
uses `--orca-sync-script F` (or `AGENTOPS_ORCA_SYNC_SCRIPT`) and preserves the old merged-PR/push
event mapping without hard-coding a macOS path.

Polling reconciliation defaults to 30000 ms and shares the same per-repository single-flight queue
as webhook deliveries. Configure it with `--reconcile-interval-ms N`; use `--no-reconcile` only
for diagnostics. Do not run `watch-github` against the same workspace at the same time as this
daemon. Repository registration is the only intake boundary: each turn also discovers existing
and new same-repository Open PRs targeting the configured base branch, imports each PR number
idempotently, and reviews every unseen current head. Draft heads are reviewed but remain pending
until ready; fork heads are not auto-repaired because target-repository write authority is not
assumed.

Claiming removes `ready` and adds `agent-claimed`. The first source snapshot and every planning /
UI-design / generation / perspective invocation retain stable provenance in `.harness/db.json`; restarts reuse
those records instead of re-planning the same source. For a pre-existing unbound legacy store, run
`npm run harness -- bind-target` once after setting the intended target.

`frontend`/`fullstack` planning candidates are each sent to a fresh, read-only `ui-designer`
session before Issue creation. Its principles, tokens, components, states/interactions,
accessibility rules, and AC traces must pass schema and invocation-provenance validation; missing,
ambiguous, or invalid output stops the whole enrichment at `needs-human-review`. Backend-only
candidates do not select or invoke the UI route. When `routes.uiDesign` is omitted, it inherits the
planning route (then the legacy generator route) while keeping a separate session/context.

`target.graders.commands` is keyed by the acceptance criterion's `verification.method`. Non-unit
methods run once per criterion with `AGENTOPS_AC_ID`, `AGENTOPS_ISSUE_ID`,
`AGENTOPS_VERIFICATION_METHOD`, and `AGENTOPS_EXPECTED_JSON`; a missing command fails closed.

## What is real vs mocked (so there are no surprises)

- **Always real:** contracts and schema validation, state transitions, the durable store,
  trace gates, scoring, evidence records, metrics, curation, dashboard, and CLI behavior.
- **Offline demo:** `npm run demo` uses deterministic agent simulation; its described artifacts,
  cost, and token values are synthetic.
- **Grounded live path:** the watcher uses real git worktrees, provider CLIs, grader commands,
  isolated reviewer checkouts, `gh`, and the existing PR gate. Repository tests fake external
  systems at their boundaries; they are not reported as proof of a real remote run.

## Develop

```bash
npm run typecheck
npm run test
```
