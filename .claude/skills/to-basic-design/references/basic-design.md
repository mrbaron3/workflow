# Basic design (bounded-context cadence)

You model the domain and architecture of **one bounded context**. This layer is global and
single-source-of-truth; you read the whole relevant context and add to it. Its cadence is coarser than a
feature on purpose: a bounded context is designed/owned across features, not re-derived per feature.

## What you write

| File | Element id | Holds |
| --- | --- | --- |
| `domain-map.md` | `DOM-NNN` | ubiquitous language, entities/aggregates, relations, context boundary, domain invariants |
| `architecture.md` | `ARCH-NNN` | module boundaries, seams, shared foundations (public shape only), cross-cutting policy |

Order: domain-map fixes the boundaries first → architecture builds on them. Data lives in a separate
skill (`to-db-design`) and follows the domain you set here.

## Lazy boundary / coherent within

- **Lazy** — do not model a context nobody has touched.
- **Coherent within** — on first touch, model the touched entity's **aggregate closure** (the entity +
  what it owns / what identifies it / what shares its invariants) at the conceptual level.
- **Falsifiable test** for "model it now?" — *"If I omit this, can a future feature re-introduce the same
  concept under a different name?"* Yes → model now (the double-design you prevent). No → defer.

## Additive only / contract altitude

- Element ids are unique and stable across the whole layer. Never renumber or reuse.
- To change something, add a **new** element + migration and deprecate the old — never rewrite an id.
- Write an element only if its absence makes another independent unit inconsistent. Internal
  algorithms/representations are not this layer's business — public shape only.

## Worked example (Todo-due, "scheduling" context, first touch)

A due date touches the scheduling aggregate. Conceptual closure is small, so the architecture delta is one
shared seam (the data column itself is the DB skill's job):

```text
architecture.md + ARCH-031  shared module core/dueDate — public shape only:
                              isOverdue(todo, now): boolean
                              compareByDue(a, b): number
                            so "what overdue/ordering means" is defined once, not re-implemented per site.
```

Not modelled: reminders, recurrence, calendars — no current AC needs them and omitting them cannot cause
aliasing. Deferred (lazy).

## Output / signal

Produce the domain/architecture delta (rich Markdown + structured core) and record `reads` / `extends`
(with affected AC-IDs) in the epic's `design-delta.md`. `check-basic-design` verifies the delta's
referenced ids are present in the system layer. Signal completion; do not change workflow state or sign.
