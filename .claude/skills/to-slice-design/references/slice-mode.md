# Slice design (epic cadence)

You decompose **one epic** (its signed `spec.md` + the system layer it touches). Slices are per-epic /
per-PR — the fast-moving end of the gradient. Decompose the epic's AC into PR-size slices that reference
the system layer.

## The structured core `check-slice-design` parses

Each `slices/SLICE-<EPIC>-NNN.md` is rich Markdown prose **plus one** fenced ```yaml core block:

```yaml
sliceId: SLICE-TODODUE-002
coversAcIds: [AC-TODODUE-002, AC-TODODUE-003]
dependsOnSlices: [SLICE-TODODUE-001]
dependsOnSystem: [DATA-014, ARCH-031]
```

Prose around it carries `narrative` (productGoal / userStory), `componentDesign`, `testApproach`,
`estimatedScope`, and optional non-gated `implementationNotes`. The core is the join-key surface for the
deterministic checks and for `IssueSpawnOrder`.

## Invariants (enforced by `check-slice-design`)

- **Coverage AND exclusivity, bidirectional**: `⋃ coversAcIds == spec AC-ID set`, no AC in two slices.
  An AC is the smallest indivisible design unit — if one AC exceeds PR size, send it back to authoring to
  split the AC, do not split it across slices.
- **sliceId stable / unique**: never renumber or reuse. On split before spawn, mint a new id.
- **DAG**: `dependsOnSlices` references known slices and has no cycle.
- **Reference, don't copy**: `dependsOnSystem` ids must exist in the system layer; never inline their
  content.
- **Seam / contract altitude only**: `componentDesign` writes the seams/contracts another unit needs to
  mesh — not class internals. Algorithms you want to fix go in `implementationNotes` (not gated — the
  internal HOW is the implementer's to decide).

## Minimal worked example (Todo-due → two slices)

`SLICE-TODODUE-001` (persist & input due date):

```yaml
sliceId: SLICE-TODODUE-001
coversAcIds: [AC-TODODUE-001]
dependsOnSlices: []
dependsOnSystem: [DATA-014]
```

`SLICE-TODODUE-002` (overdue display & sort) depends on the first (persistence first):

```yaml
sliceId: SLICE-TODODUE-002
coversAcIds: [AC-TODODUE-002, AC-TODODUE-003]
dependsOnSlices: [SLICE-TODODUE-001]
dependsOnSystem: [DATA-014, ARCH-031]
```

Coverage check: `{001} ∪ {002,003} == {001,002,003}`, no overlap. OK.

## Output / signal

For each slice emit an `IssueSpawnOrder` (version-pinned references only — spec / acceptance / slice /
design-delta / system elements + AC/MR ids + `dependsOn`). That is the handoff to the resolve step and
the **completion signal**. Run `check-slice-design <epic-dir>` first. You do not change workflow state
and do not sign.
