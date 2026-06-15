# Issue Contract — <ISSUE-ID> <title>

> **これは resolve 由来の派生物であり、手書きの SoT ではない**（ADR-0001 D8/D13）。
> M05 Issue Contract Planner が `resolve(spec.md@gitSha の AC behavior + acceptance.yaml の
> verification + Tier2 設計スライス)` を dispatch 時に機械生成する。オーサリング SoT は
> spec.md（人間署名）。本テンプレートは resolve 後の形を示す参考であり、issue へ埋め込まず
> `specRef`(path+gitSha) + AC-ID 群 + スライス参照で持つ（[design-planner.md](../docs/spec/modules/design-planner.md)）。

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
      method: playwright       # 自動採点のみ: build|typecheck|unit_test|api_test|db_state_check|playwright|secrets_scan|scope_check|llm_rubric（manual は不可。非自動は manual-requirements.md へ）
      expected:
        - "<concrete, checkable expectation>"
```

## Red Lines

- <thing the implementation must never do, e.g. "do not fake persistence with local state">
- <e.g. "do not change the contract after implementation">
