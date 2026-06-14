# Issue Contract — <ISSUE-ID> <title>

A Generator must be able to implement this from the contract alone. If a Generator
has to guess, the contract is the bug. The `acceptanceCriteria` block is parsed by
the harness (it must satisfy the IssueContract schema in src/domain/schema.ts).

## Product Goal
<one sentence: the user value this delivers>

## User Story
As a <role>, I want <capability> so that <benefit>.

## Scope
### Include
- <in scope>
### Exclude
- <explicitly out of scope — guards against scope creep>

## Acceptance Criteria
```yaml
acceptanceCriteria:
  - id: AC-001
    severity: blocker          # blocker | major | minor
    behavior: "<observable behaviour>"
    verification:
      method: playwright       # build|typecheck|unit_test|api_test|db_state_check|playwright|secrets_scan|scope_check|llm_rubric|manual
      expected:
        - "<concrete, checkable expectation>"
```

## Red Lines
- <thing the implementation must never do, e.g. "do not fake persistence with local state">
- <e.g. "do not change the contract after implementation">
