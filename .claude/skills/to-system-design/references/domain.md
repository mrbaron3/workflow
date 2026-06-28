# Language, domain & architecture (system layer · bounded-context granularity)

You model the **ubiquitous language, domain, and architecture** of **one bounded context**. This layer is
global and single-source-of-truth; you read the whole relevant context and add to it. Its granularity is
coarser than a spec on purpose: a bounded context is designed/owned across specs, not re-derived per spec.

## What you write

| File (under `_system/<ctx>/`) | Element id | Holds |
| --- | --- | --- |
| `ubiquitous-language.md` | `LANG-<CTX>-NNN` | the vocabulary every doc in this context is written in (per-context glossary) |
| `domain-model.md` | `DOM-<CTX>-NNN` | entities/aggregates, relations, context boundary, invariants, domain events, state |
| `architecture.md` | `ARCH-<CTX>-NNN` | module boundaries, seams, shared foundations (public shape only), cross-cutting policy |

Order: language first (it fixes the words) → domain-model (entities in those words) → architecture (the
seams that realise them). Data is the **next perspective in this skill** ([references/data.md](data.md))
and follows the domain you set here.

## Per-context language (why it is its own view)

A word's meaning is bound to its context — "Order" in an ordering context is not the "Order" a shipping
context handles. So the glossary is **per-context** (`_system/<ctx>/ubiquitous-language.md`), never one
global dictionary. Domain/arch/data/spec all reference `LANG-<CTX>-NNN` terms rather than redefining them.
Cross-context translation points (the ACL) are named in `context-map.md` when that index exists.

## Lazy boundary / coherent within

- **Lazy** — do not model a context nobody has touched.
- **Coherent within** — on first touch, model the touched entity's **aggregate closure** (the entity +
  what it owns / what identifies it / what shares its invariants) at the conceptual level.
- **Falsifiable test** for "model it now?" — *"If I omit this, can a future spec re-introduce the same
  concept under a different name?"* Yes → model now (the double-design you prevent). No → defer.

## Additive only / contract altitude

- Element ids are unique and stable **within the context**. Never renumber or reuse.
- To change something, add a **new** element + migration and deprecate the old — never rewrite an id.
- Write an element only if its absence makes another independent unit inconsistent. Internal
  algorithms/representations are not this layer's business — public shape only.

## Worked example (Todo-due, "scheduling" context, first touch)

A due date touches the scheduling aggregate. The closure is small:

```text
ubiquitous-language.md + LANG-scheduling-001  "Due date" — an optional single calendar date by which a
                                               Todo is meant to be done.
                       + LANG-scheduling-002  "Overdue" — the derived state of a Todo whose due date is
                                               strictly before "now".
domain-model.md + DOM-scheduling-001          Todo aggregate owns at most one due date (0..1); overdue is
                                               DERIVED, never stored; no due date is a valid state.
architecture.md + ARCH-scheduling-031         core/dueDate seam, public shape only:
                                               isOverdue(todo, now): boolean
                                               compareByDue(a, b): number   (missing date sorts last)
```

Not modelled: reminders, recurrence, calendars — no current AC needs them and omitting them cannot cause
aliasing. Deferred (lazy).

## Output / signal

Produce the language/domain/architecture delta (rich Markdown + ids) and record `reads` / `extends` (with
affected AC-IDs) in the spec's `design-delta.md`. `check-system-design` verifies the delta's referenced ids
are present in the system layer. Signal completion; do not change workflow state or sign.
