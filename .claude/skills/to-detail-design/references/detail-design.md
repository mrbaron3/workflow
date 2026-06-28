# Detail design (spec granularity)

You decompose **one signed `spec.md`** (and the system layer it touches) into a set of PR-size
**Issues**, emitted as `issues.yaml`. Issues are the nano unit (DOC_TAXONOMY §NANO): their state lives
in the store, not in markdown — so you author a spawn *manifest*, never slice documents. You reference
the system layer; you do not author it.

## The manifest `check-detail-design` parses

`issues.yaml` is one `issues:` list. Each entry:

```yaml
issues:
  - key: ISSUE-TODODUE-002          # draft-local handle; store ISSUE-NNNN allocated at spawn
    title: Observe overdue and order by due date (null-last)
    area: backend
    type: story                     # optional, default story
    coversAcIds: [AC-TODODUE-002, AC-TODODUE-003]
    dependsOnIssues: [ISSUE-TODODUE-001]
    dependsOnSystem: [DATA-scheduling-014, ARCH-scheduling-031]
    implementationNotes:            # optional, NOT gated
      - "Consumed only through the ARCH-scheduling-031 core/dueDate seam: isOverdue(todo, now), compareByDue(a, b)."
```

`key` + `coversAcIds` + `dependsOnIssues` + `dependsOnSystem` are the join-key surface the checks read.
`title` / `area` / `type` / `implementationNotes` carry the design intent the later contract-drafting
and the implementer need; they are not gated.

## Invariants (enforced by `check-detail-design`)

- **Coverage AND exclusivity, bidirectional**: `⋃ coversAcIds == spec AC-ID set`, no AC in two issues.
  An AC is the smallest indivisible design unit — an oversized AC goes back to authoring to split the AC.
- **key stable / unique**: never renumber or reuse within the set. On split before spawn, mint a new key.
- **DAG**: `dependsOnIssues` references known keys in the set and has no cycle.
- **Reference, don't copy**: `dependsOnSystem` ids (`…-<CTX>-NNN`) must exist in the system layer; never
  inline their content.
- **Seam / contract altitude only**: `implementationNotes` writes the seams/contracts another unit needs
  to mesh — not class internals; the internal HOW is the implementer's to decide.

## System element ids are context-segmented

`dependsOnSystem` points at `<KIND>-<CTX>-NNN` ids (e.g. `DOM-scheduling-001`, `DATA-scheduling-014`,
`ARCH-scheduling-031`, `CONTRACT-scheduling-002`) authored by to-system-design under
`_system/<context>/`. The check reads every `*.md` beneath `_system/` recursively, so a ref resolves
regardless of which context file defines it. You reference these ids; you never mint or rewrite them.

## Worked example (Todo-due → two issues)

```yaml
issues:
  - key: ISSUE-TODODUE-001
    title: Set and persist a Todo due date
    area: backend
    coversAcIds: [AC-TODODUE-001]
    dependsOnIssues: []
    dependsOnSystem: [DATA-scheduling-014]
  - key: ISSUE-TODODUE-002
    title: Observe overdue and order by due date (null-last)
    area: backend
    coversAcIds: [AC-TODODUE-002, AC-TODODUE-003]
    dependsOnIssues: [ISSUE-TODODUE-001]
    dependsOnSystem: [DATA-scheduling-014, ARCH-scheduling-031]
```

Coverage check: `{001} ∪ {002,003} == {001,002,003}`, no overlap. OK.

## Output / signal

`issues.yaml` is the spawn manifest and the completion signal. A deterministic ingest allocates each
`ISSUE-NNNN`, sets its `featureId` / `specPath` (the planning-tree link) and lands it in the store. You
emit the manifest and stop; you do not change workflow state or sign — an independent review follows.
