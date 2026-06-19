# Glossary

> ⚠️ ADR-0001 で二層モデル（オーサリング層 / 実行層）を導入。下記の階層図は旧モデルで、新設計では
> **Epic = 1 spec.md**（人間署名の WHAT）であり、**Issue Contract は M05 resolve の派生物**（手書きせず
> spec.md@gitSha + acceptance.yaml + Tier2 スライスから生成）。新設計の下書きは [draft/_spec/](../draft/_spec/)（draft）+ ADR-0001。
> 新語は下表末尾に追加。

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
| **spec.md（オーサリング SoT）** | 1 機能=1 epic の WHAT。人間が AC の behavior を書き署名する正本（ADR D4）。 |
| **acceptance.yaml** | AC-ID→verification(method+expected) を分離した grader 向け SoT（O1 反転・D15）。 |
| **manual-requirements.md** | 自動採点できない要件（MR-ID）を tier 別に分離した要審査票（B 方針・D7）。 |
| **ApprovedSpecRef** | contract-approved の実体: path + 署名 commit gitSha + acFingerprints + approvedAcIds（M20 産）。 |
| **Tier1 アーキ・スパイン / ArchitectureSpine** | epic 共有の設計決定のみ（M21 産・D14）。 |
| **Tier2 設計スライス / DesignSlice** | PR サイズの設計単位。1 スライス=1 issue（M21 産・D14）。 |
| **IssueSpawnOrder** | M21→M03/M05 の handoff。参照のみ・全 Ref 版固定（D8/D13）。 |
| **contract-approved vs build-approved** | 前者は人間の WHAT 署名（epic）、後者は eval 合格（issue）。ADR §5 で改名し区別。 |
