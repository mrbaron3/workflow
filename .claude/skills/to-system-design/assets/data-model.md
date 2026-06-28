<!--
  data-model for one bounded context (DOC_TAXONOMY view 4 — データ). Lives at
  _system/<ctx>/data-model.md. Global within the context, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - DATA-<CTX>-NNN ids are unique and stable within the context — never renumber/reuse.
  - STRUCTURED SSOT = the DBML block. The Mermaid erDiagram (and any SQL DDL) are DERIVED from it —
    author the DBML, regenerate the diagram (DOC_TAXONOMY §データビューの実体化). Don't hand-edit the
    diagram to diverge from the DBML.
  - Data follows the domain: realise DOM-<CTX>-NNN entities, do not invent new concepts here.
  - Materialise only the physical columns the current acceptance criteria need (lazy).
  - Tag each DATA-<CTX>-NNN element where it lives (a DBML comment/note), so the id is referenceable.
-->

# Data model — <context> context

## Logical model (DBML — structured SSOT)

```dbml
// DATA-<CTX>-NNN <table-or-column> — <one-line purpose>; realises DOM-<CTX>-NNN. owner: <module>.
Table <table> {
  <id> <type> [pk]
  <col> <type> [null, note: 'DATA-<CTX>-NNN — <meaning>; null = <first-class meaning>, not a sentinel']
}
// Ref: <table>.<fk> > <other>.<id>   // relations are first-class in DBML
```

## Entity–relationship (Mermaid — DERIVED from the DBML above)

```mermaid
erDiagram
  <TABLE> {
    <type> <col>
  }
```

## Persistence contract & migration

- **DATA-<CTX>-NNN** — migration: <additive strategy, e.g. add nullable column, no backfill>;
  back-compat: <e.g. existing rows read as null; readers unaware of the column are unaffected>.
