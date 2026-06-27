<!--
  data-model for one bounded context. Global, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - DATA-NNN ids are unique and stable across the WHOLE system layer — never renumber/reuse.
  - Data follows the domain: realise domain entities, do not invent new concepts here.
  - Materialise only the physical columns the current acceptance criteria need (lazy).
  - This file feeds the (derived) ER diagram; keep the schema lists machine-parseable.
-->

# Data model — <context> context

## Logical model

- **DATA-NNN <table / entity>**
  - owner: <module that owns writes>
  - columns: `<name>: <type>` (nullable?), ...
  - keys: pk `<…>`; fk `<…> → <table>`

## Persistence contract & migration

- **DATA-NNN** — migration: <how existing data is handled>; back-compat: <e.g., existing rows read as null>.
