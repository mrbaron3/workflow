# Domain model (system layer · view 2 of 4)

You model the **domain** of **one bounded context** — entities, aggregates, invariants, domain events, and
state machines, all expressed in the ubiquitous language. Global, single-source-of-truth, additive only.
You read the whole relevant domain model and add to it. Cadence is coarser than a spec on purpose: a
bounded context is designed/owned across specs, not re-derived per spec.

## What you write

| File (under `_system/<ctx>/`) | Element id | Holds |
| --- | --- | --- |
| `domain-model.md` | `DOM-<CTX>-NNN` | entities/aggregates, relations, context boundary, invariants, domain events, state |

Template: the skill's `assets/domain-model.md`.

## Language first — reference, don't redefine

Read `ubiquitous-language.md` ([language.md](language.md)) first. Every concept you model is named there;
reference `LANG-<CTX>-NNN`, never restate a definition. If you need a concept the glossary lacks, that is a
language gap — name the term first (or flag it back to the language view), then model it.

## Aggregate closure (lazy / coherent within)

- **Coherent within** — on first touch, model the touched entity's **aggregate closure** (the entity + what
  it owns / what identifies it / what shares its invariants) at the conceptual level, so a later spec cannot
  re-introduce the same concept under a different name.
- **Lazy** — do not model a context nobody has touched, and within the touched aggregate materialise only
  what the current need requires.
- **Falsifiable test** — *"If I omit this, can a future spec re-introduce the same concept under a different
  name?"* Yes → model now. No → defer.

## Additive only / contract altitude

- `DOM-<CTX>-NNN` ids are unique and stable within the context. Never renumber or reuse.
- A change is a **new** element + migration + deprecate-the-old — never a rewrite of an existing id.
- Public shape only: invariants, events, and state another unit must agree on. Internal
  algorithms/representations are the implementer's, not this layer's.

## Worked example (Todo-due, "scheduling" context, first touch)

```text
DOM-scheduling-001  Todo aggregate owns at most one due date (0..1); "overdue" (LANG-scheduling-002) is
                    DERIVED, never stored; "no due date" is a valid state, not a sentinel.
```

Not modelled: reminders, recurrence, calendars — no current AC needs them and omitting them cannot cause
aliasing. Deferred (lazy).

## Reverse mode (distilling from code)

When the source is existing code, recover entities/aggregates from the data and the **invariants the code
actually enforces** (validations, guards, state transitions, unique constraints) — not the rules someone
wished for. Tag each with `file:symbol` evidence; the output is a **draft proposal** for human review. See
[reverse.md](reverse.md).

## Hand off

Architecture ([architecture.md](architecture.md)) builds the seams that realise these boundaries, and data
([data.md](data.md)) realises these entities as tables — both reference your `DOM-<CTX>-NNN` ids. Record your
`extends` in the run's delta. Signal completion; do not change workflow state or sign.
