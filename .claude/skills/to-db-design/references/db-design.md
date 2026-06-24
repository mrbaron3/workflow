# DB design (bounded-context cadence)

You model the data of **one bounded context**. This layer is global and single-source-of-truth; you read
the whole relevant data model and add to it. Cadence is coarser than a feature on purpose — the data model
is owned across features, so two features that touch the same concept must not model it twice.

## What you write

| File | Element id | Holds |
| --- | --- | --- |
| `data-model.md` | `DATA-NNN` | logical model → schema (tables/columns), ownership, keys, migration, persistence contract |

**Data follows the domain.** Read `domain-map.md` first; your tables/columns realise the domain entities,
they do not invent new concepts. If you find yourself naming a new concept, that belongs in basic design.

## Lazy boundary / coherent within

- **Coherent** — model the touched aggregate's data coherently (ownership, keys, relations) so a later
  feature cannot add the same entity under a different table/name.
- **Lazy** — materialise only the physical columns the current acceptance criteria need. Defer the rest;
  add them additively when an AC requires them.
- **Falsifiable test** for a column/table: *"If I omit this, can a future feature re-introduce the same
  data under a different name?"* Yes → model now. No → defer.

## Additive only / migration

- `DATA-NNN` ids are unique and stable. Never renumber or rewrite an existing id's meaning.
- A change is a **new** element + a migration, with a back-compat note (e.g., existing rows read as null).

## Worked example (Todo-due, "scheduling" context, first touch)

```text
data-model.md + DATA-014  todos.dueDate (nullable, ISO-8601).
                          owner: todo module. Existing rows read as null (back-compat).
```

Only the one column the AC needs is materialised; the rest of any scheduling schema is deferred (lazy).

## Output / signal

Produce the data-model delta (rich Markdown + structured core) and record `reads` / `extends` (with
affected AC-IDs) in the epic's `design-delta.md`. `check-db-design` verifies the delta's referenced ids
are present in the system layer. Signal completion; do not change workflow state or sign.
