<!--
  data-model for one bounded context (DOC_TAXONOMY view 4 — データ). Lives at
  _system/<ctx>/data-model.md. Global within the context, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - DATA-<CTX>-NNN ids are unique and stable within the context — never renumber/reuse.
  - STRUCTURED SSOT = whatever matches the actual persistence (one source, never a duplicate):
      • relational DB        → a DBML block (use section §A below)
      • JSON/document store, or an in-process store validated by code types (Zod/TS, pydantic,
        JSON Schema) → REFERENCE the live code schema (use section §B); do NOT transcribe it to DBML.
    Keep only the section that fits; delete the other. The Mermaid erDiagram is DERIVED from whichever
    SSOT you keep — regenerate it, don't hand-edit it to diverge (DOC_TAXONOMY §データビューの実体化).
  - Data follows the domain: realise DOM-<CTX>-NNN entities, do not invent new concepts here.
  - Materialise only what the current acceptance criteria need (lazy). SKIP this whole file when the
    change persists no new state (a pure status/flag mutation adds no DATA-<CTX>-NNN element).
  - Tag each DATA-<CTX>-NNN element where it lives (a DBML note, or a one-line schema-reference entry),
    so the id stays referenceable.
-->

# Data model — <context> context

## §A Logical model — relational DB (DBML — structured SSOT) <!-- delete §A if the store is not relational -->

```dbml
// DATA-<CTX>-NNN <table-or-column> — <one-line purpose>; realises DOM-<CTX>-NNN. owner: <module>.
Table <table> {
  <id> <type> [pk]
  <col> <type> [null, note: 'DATA-<CTX>-NNN — <meaning>; null = <first-class meaning>, not a sentinel']
}
// Ref: <table>.<fk> > <other>.<id>   // relations are first-class in DBML
```

## §B Logical model — code-schema reference (structured SSOT lives in the code) <!-- delete §B if the store is relational -->

> The live schema is the SSOT; this file only adds the `DATA-…` id, ownership and meaning. Reference,
> never re-type the fields (a second copy drifts).

- **DATA-<CTX>-NNN `<Type>.<field>`** — <one-line purpose>; realises DOM-<CTX>-NNN.
  source: `<path-to-schema>` → `<Type>` (<Zod|TS|pydantic|JSON-Schema>). owner: <module>.
  shape: `<field>: <type>` (<meaning; if nullable, what null means as a first-class value>).

## Entity–relationship (Mermaid — DERIVED from the SSOT above)

```mermaid
erDiagram
  <TABLE-or-Type> {
    <type> <field>
  }
```

## Persistence contract & migration

- **DATA-<CTX>-NNN** — migration: <additive strategy, e.g. add nullable column / optional field, no backfill>;
  back-compat: <e.g. existing rows/records read as null; readers unaware of the field are unaffected>.
