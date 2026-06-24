# System-layer design (bounded-context cadence)

You model **one bounded context**. The system layer is global and single-source-of-truth; you read the
whole relevant context and add to it. Its cadence is coarser than a feature on purpose: a bounded context
is designed/owned across features, not re-derived per feature.

## What you write

| File | Element id | Holds |
| --- | --- | --- |
| `_system/.../domain-map.md` | `DOM-NNN` | ubiquitous language, entities/aggregates, relations, context boundary, domain invariants |
| `_system/.../data-model.md` | `DATA-NNN` | logical model → schema (tables/columns), ownership, migration, persistence contract |
| `_system/.../architecture.md` | `ARCH-NNN` | module boundaries, seams, shared foundations (public shape only), cross-cutting policy |

Rich Markdown for humans **plus** a machine-extractable structured core (so diagrams render
deterministically). Order within a context: domain-map fixes the boundaries → data-model and
architecture build on them.

## Lazy boundary / coherent within

The rule that stops both speculative design and double-design:

- **Lazy** — do not model a context nobody has touched.
- **Coherent within** — on first touch, model the touched entity's **aggregate closure** (the entity +
  what it owns / what identifies it / what shares its invariants) at the *conceptual* level. Materialise
  *physical* schema only for the current acceptance criteria.
- **Falsifiable test** for "should I model this now?" — *"If I omit this, can a future feature
  re-introduce the same concept under a different name?"* **Yes** → model it now (that is the
  double-design you are preventing). **No** → defer; add it additively when an AC needs it.

Don't bake a fixed threshold; when double-design or over-modelling actually shows up, adjust. The
independent review checks global consistency; the bounded-context owner is the backstop.

## Additive only

- Element ids are unique and stable across the whole system layer. Never renumber or reuse.
- To change something, add a **new** element (+ migration) additively and mark the old one deprecated —
  never rewrite an existing id's meaning.
- Contract altitude only: write an element only if its absence makes another independent unit
  inconsistent. Internal algorithms/representations are not the system layer's business.

## Minimal worked example (Todo-due, "scheduling" context, first touch)

Adding a due date touches the scheduling aggregate. Conceptual closure here is small (the Todo entity's
temporal attribute), so the delta is one data element + one shared seam:

```text
data-model.md   + DATA-014  todos.dueDate (nullable, ISO-8601). Existing rows read as null (back-compat).
architecture.md + ARCH-031  shared module core/dueDate — public shape only:
                              isOverdue(todo, now): boolean
                              compareByDue(a, b): number
                            so "what overdue/ordering means" is defined once, not re-implemented per call site.
```

Not modelled: reminders, recurrence, calendars — other parts of a scheduling context, but no current AC
needs them and omitting them cannot cause aliasing. Deferred (lazy).

## Output / signal

Produce the system delta (rich Markdown + structured core) and the epic's `design-delta.md` recording
`reads` / `extends` (with the affected AC-IDs). `check-system-design` verifies the delta's referenced ids
are present in the system layer. You signal completion; you do not change workflow state and do not sign.
