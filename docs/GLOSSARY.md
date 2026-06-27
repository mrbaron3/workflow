# Glossary

The brief's most important early fix: stop overloading "Sprint" to mean "one feature".
A Sprint is a **time-box**; the unit of agent work is an **Issue Contract**.

```text
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
| **Epic** | 下流のロードマップ/進捗グルーピング（issue の束・`Issue.epicId`）。**著述単位ではない**（1 spec ≠ 1 epic）。A big capability decomposed into many issues. |
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
| **Spec** | 粒度非依存の**著述・署名単位**: 署名済み `spec.md` + `acceptance.yaml`（= `contract-approved`）。1つの凝集した署名可能 capability。1 spec ≠ 1 epic。 |
| **spec.md（オーサリング SoT）** | 任意粒度の WHAT（1 spec = 著述・署名単位・**1 機能=1 epic ではない**）。人間が AC の behavior を書き署名する正本。 |
| **acceptance.yaml** | AC-ID→verification(method+expected) を分離した grader 向け SoT。 |
| **manual-requirements.md** | 自動採点できない要件（MR-ID）を tier 別に分離した要審査票。 |
| **ApprovedSpecRef** | contract-approved の実体: **spec** を指す path + 署名 commit gitSha + acFingerprints + approvedAcIds（M20 産）。 |
| **Tier1 アーキ・スパイン / ArchitectureSpine** | epic 共有の設計決定のみ（M21 産）。 |
| **Tier2 設計スライス / DesignSlice** | PR サイズの設計単位。1 スライス=1 issue（M21 産）。 |
| **IssueSpawnOrder** | M21→M03/M05 の handoff。参照のみ・全 Ref 版固定。 |
| **contract-approved vs build-approved** | 前者は人間の WHAT 署名（**spec**）、後者は eval 合格（issue）。 |
