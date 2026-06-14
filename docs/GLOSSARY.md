# Glossary

The brief's most important early fix: stop overloading "Sprint" to mean "one feature".
A Sprint is a **time-box**; the unit of agent work is an **Issue Contract**.

```
Roadmap
  └─ Theme / Initiative
       └─ Epic
            └─ Feature / Story / Bug / Tech-debt / Harness / Eval  (Issue)
                 └─ Issue Contract            ← the unit an agent implements
                      └─ Agent Work Unit / sample
                           └─ PR
                                └─ Eval Run (Scorecard)
                                     └─ Finding → Repair
```

| Term | Meaning |
| --- | --- |
| **Roadmap** | What to build, in what order, and why. |
| **Theme / Initiative** | A large investment area (e.g. "onboarding"). |
| **Epic** | A big capability decomposed into many issues. |
| **Agile Sprint** | A time-box (e.g. `sprint:2026-W24`) that *contains* issues/epics. Not a feature. |
| **Issue Contract** | One issue made implementable **and** gradable: goal, story, scope, acceptance criteria, red lines. |
| **Agent Work Unit / sample** | One independent attempt at an Issue Contract by one agent. |
| **PR** | A Generator's output (a branch + diff). |
| **Eval Run** | An Evaluator/grader execution over a PR → a Scorecard, stored in the Eval DB. |
| **Scorecard** | The structured verdict: hard gates, findings, scores, evidence, next action. |
| **Repair Loop** | Generator fixes the same PR in response to findings, then it's re-evaluated. |
| **Eval Task Registry** | The dataset of re-runnable eval tasks (regressions) curated from real failures. |
| **Grader** | A checker: deterministic (build/tests/Playwright/scope) or rubric/LLM. |
| **Evidence** | Trace/screenshot/logs/scorecard proving why a verdict was given. |
| **pass@k** | Probability ≥1 of k samples passes — exploration. Rises with k. |
| **pass^k** | Probability all k samples pass — consistency. Falls with k. |
| **False pass / fail** | Grader says pass/fail but a human disagrees — measures grader quality. |
| **Harness improvement** | A change to prompts / contracts / graders / routing / dashboard — on the *same* roadmap as features. |
