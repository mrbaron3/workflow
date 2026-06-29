# Architecture (system layer · view 3 of 4)

You design the **architecture** of **one bounded context** — module boundaries, seams, shared foundations
(public shape only), and cross-cutting policy. It is built on the domain: the seams realise the aggregates
and invariants the domain view fixed. Global, single-source-of-truth, additive only.

## What you write

| File (under `_system/<ctx>/`) | Element id | Holds |
| --- | --- | --- |
| `architecture.md` | `ARCH-<CTX>-NNN` | module boundaries, seams, shared foundations (public shape), cross-cutting policy, invariants |

Template: the skill's `assets/architecture.md`.

## Built on the domain — seams realise boundaries

Read `domain-model.md` ([domain.md](domain.md)) first. A seam exists to host a domain boundary or invariant;
reference the `DOM-<CTX>-NNN` (and `LANG-<CTX>-NNN`) it serves, never restate them. If a seam implies a new
concept, that belongs in the domain (or language) view — go fix it there first, don't smuggle it in here.

## Public shape only (contract altitude)

Write the signature/contract another unit must mesh with — `fn(args): ret`, a seam's responsibility, a
cross-cutting rule (how errors/time/ids cross boundaries). Never the internal algorithm or representation:
that dates the design and pre-decides the implementer's work. Component and sequence diagrams are derived
downstream from these seams, not authored here.

## Lazy / additive

- Add a seam only if its absence makes another independent unit inconsistent (the falsifiable test).
- `ARCH-<CTX>-NNN` ids are unique and stable within the context — additive only, never renumber/rewrite.

## Worked example (Todo-due, "scheduling" context, first touch)

```text
ARCH-scheduling-031  core/dueDate seam — public shape only:
                       isOverdue(todo, now): boolean    (realises DOM-scheduling-001 / LANG-scheduling-002)
                       compareByDue(a, b): number       (missing date sorts last)
```

The date's internal representation, its storage, and the sort algorithm are left to the implementer. Other
scheduling seams (reminders, recurrence) are deferred (lazy).

## Reverse mode (distilling from code)

When the source is existing code, recover the **real** boundaries and seams — what actually depends on what
(exports, interfaces, routes, package edges) — not an idealised layering. Tag each with `file:symbol`
evidence; the output is a **draft proposal** for human review. See [reverse.md](reverse.md).

## Hand off

Record your `extends` (new `ARCH-<CTX>-NNN` ids) in the run's delta. Signal completion; do not change
workflow state or sign.
