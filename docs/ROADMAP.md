# Build roadmap (v0 → v3)

Mirrors the brief's staging. This MVP delivers **v0 in full** plus a thin slice of
v1/v2/v3 so the whole shape is visible and runnable.

## v0 — get one PR loop through (DONE)

Goal: from one Issue Contract, produce a PR, evaluate it (gates + per-criterion checks),
return findings, repair, pass, and persist the result.

- [x] Issue Contract template + schema
- [x] Generator (mock) + repair loop
- [x] Evaluator (hard gates + composite score) + Scorecard
- [x] Evidence store (trace / artifact / scorecard / screenshot)
- [x] PR scorecard format
- [x] Labels / state machine
- [x] Eval Result DB (`.harness/db.json`)

## v1 — roadmap / epic management (DONE for MVP)

Goal: manage multiple epics/issues and let the Coordinator stream them through.

- [x] Roadmap + Issue planning from a seed
- [x] Epic templates + progress
- [x] Coordinator loop over all drafted issues
- [x] Basic dashboard
- [ ] Real multi-agent dispatch / concurrency (today: sequential)
- [ ] GitHub Project / Issues backend (today: local JSON)

## v2 — real evaluation harness (PARTIAL)

Goal: pass@1 / pass@k / pass^k by agent / prompt / grader / issue type.

- [x] pass@1 / pass@k / pass^k (unbiased estimators) + per-agent breakdown
- [x] Eval Task Registry + curation from real failures
- [x] Evidence browser (links on the dashboard)
- [x] Cost / token / time tracking (synthesised in mock)
- [ ] **Isolated execution environment** (fresh worktree, clean DB, seed data) + **real graders** running against a target repo — the main thing standing between mock and production
- [ ] Grader auditor (false-pass/fail) beyond manual `label`
- [ ] Flaky-eval detection across repeated identical runs

## v3 — harness improvement as auto-issues (PARTIAL)

Goal: failure trends become harness-improvement issues automatically.

- [x] Harness Analyst: metric-driven suggestions → `type:harness` / `type:eval` issues
- [x] Failure heatmap (area × failure type)
- [ ] Routing rules (e.g. "send backend issues to Codex") applied automatically
- [ ] Scheduled retros that open issues on a cadence
- [ ] Prompt/grader/contract **versioning** with A/B comparison across versions

## Suggested next step

Wire **one** real path end-to-end: pick a tiny target repo, implement a real
`playwright`/`unit_test` grader in `graders/`, and run `--agent claude` against it for a
single issue. That converts the v2 "PARTIAL" into the first true production data point;
everything else (metrics, dashboard, curation) already consumes it unchanged.
