# Spec format (authoring layer)

Concise rules. Full spec: `docs/spec/modules/authoring-layer.md`.

## spec.md (human-owned, rich Markdown, no frontmatter)

```text
# <機能名> 受け入れ要件
（冒頭に WHAT/HOW 境界の一言 + system 層を固定制約として参照する旨）

## サブ機能一覧            表: ID | サブ機能 | 優先度

## <サブ機能>
  ユーザーストーリー       誰が / 何を / なぜ
  事前条件                 前提状態・他機能・_system/ の固定制約
  受け入れ基準             名前付き Given/When/Then。各に AC-ID:
                            - **[AC-<FEATURE>-001] 正常系: <名前>**
                              - Given <前提>
                              - When <操作>
                              - Then <観測可能な結果>
  非機能要件               性能 / セキュリティ / 可観測性（自動採点不能は manual へ）
  完了条件                 自動テスト / SLO / デモ

## レッドライン           実装が絶対にしてはならないこと
```

## acceptance.yaml (AI proposes, human confirms — grader-facing)

```yaml
verifications:
  AC-<FEATURE>-001:
    severity: blocker | major | minor
    method: build | typecheck | unit_test | api_test | db_state_check | playwright | secrets_scan | scope_check | llm_rubric
    expected:
      - "<grader が判定できる具体値>"
```

## manual-requirements.md (non-auto requirements only)

```text
manualRequirements:
  - id: MR-<FEATURE>-001
    severity: ...
    requirement: ...
    tier: audit | static_analysis | human_review | integration_test
    verifier: ...
```

## Invariants the check enforces

- Every spec.md AC-ID has a matching `acceptance.yaml` key, and vice versa (bidirectional coverage).
- No duplicate AC-IDs.
- No `manual` method in `acceptance.yaml`.

AC-ID identity is stable forever; only its content hash changes on edits (drift). The leading bold anchor
placement is cosmetic and tunable — what the check needs is one extractable, stable ID per scenario.
