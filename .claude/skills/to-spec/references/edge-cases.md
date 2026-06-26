# Edge cases & judgment calls in spec-shaping

The non-obvious calls the happy-path template doesn't cover. Read this when an intake doesn't fit the
straight "one decided feature → one `spec.md`" path. Each item is a **judgment**: the skill surfaces
the decision point; the human decides.

## Spec scope (cohesion, not carving)

A spec is **granularity-independent**: it can be a one-field feature or a whole subsystem. You do
**not** carve it into epics or slices — that decomposition is downstream (the design layer slices a
spec into issues; ADR-0008). Two rules of thumb instead:

- **Keep one spec to a single coherent, human-signable capability.** The test is whether a person can
  review and sign it as *one* contract.
- **If the ask is roadmap-sized** (a whole product, e.g. "build a Todo app"), say so and split it into
  several specs **upstream** (north-star / roadmap) — don't force a product into one spec. "Add a due
  date to tasks" is one spec; "build the whole app" is a roadmap of several specs.

Mechanically `to-spec` never rejects a large spec; this is guidance, not a gate.

## Sub-features are slicing hints, not slices

The "サブ機能一覧" table hints at split boundaries for the design layer (to-detail-design), which
slices the whole spec into issues. It is **not** a list of independently-shippable slices, and its rows
**may depend on each other**. Don't pre-slice the spec into standalone issues yourself — that
decomposition is the design layer's job (ADR-0004 / ADR-0008). Leaking slice decomposition up into the
spec over-constrains the solution space.

## Meta-features: layer the schema away from the process

Some features define a **contract or format** — e.g. the authoring layer defines the shape of
`spec.md` / `acceptance.yaml` themselves. Writing that format *into its own spec.md* is circular: the
spec would define the spec. Resolve it by layering:

- The **schema** (formats, ID rules, GWT conventions, method enums, join keys) belongs in the
  **system-layer data-model** — forward-reference it (below), don't define it here.
- This **spec.md** stays on the **observable process and gate behavior**: what the gate passes and
  drops, what signing persists, how drift demotes. It describes *what the artifacts do*, not *what an
  AC-ID is*.

## Greenfield forward-references

When a referenced system-layer artifact (domain map, data-model) **doesn't exist yet** — the design
layer hasn't seeded it — do not embed a copy to compensate. Express the dependency in three places so
it stays a reference, not a duplication:

1. **Precondition** — note the artifact is pending / seed-planned, and the ordering (design layer
   seeds it before signing).
2. **Red line** — forbid embedding the domain / data / schema into `spec.md` (ADR-0004 D31).
3. **Acceptance criterion** — pin the referenced elements (e.g. `systemRefs` with version-pinned
   gitSha) as **target behavior**, valid even before the upstream exists.

## Process belongs in prose, not in ACs

Acceptance criteria grade **observable artifact properties**. Collaboration quality, who-writes-what
division of labour, and subjective readability are **process** — not auto-gradable. Keep them in
preconditions / non-functional prose, surface non-gradable requirements in chat, and don't lift them
into ACs (contract altitude, ADR-0003).

When you *do* lift a separation rule into an AC, grade the **structural** property, not word
occurrence. Watch for **self-tension**: a spec that forbids `X` in its artifacts usually has to
mention "X" in prose to state the rule. Example: an AC "spec.md contains no grading" should grade the
absence of structured grading key lines (`severity:` / `method:`), not the absence of the word
"severity" — which the prose legitimately uses to describe the division.
