<!--
  domain-map for one bounded context. Global, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - DOM-NNN ids are unique and stable across the WHOLE system layer — never renumber/reuse.
  - Write an element only if its absence makes another independent unit inconsistent.
  - This file feeds the (derived) domain diagram; keep the lists below machine-parseable.
-->

# Domain map — <context> context

## Ubiquitous language

| Term | Meaning |
| --- | --- |
| <Term> | <one-line meaning used consistently everywhere> |

## Entities & aggregates

- **DOM-NNN <Entity>** — identity: <what identifies it>; owns: <…>; aggregate root: <yes/no>.

## Relations & boundaries

- <EntityA> <relation> <EntityB>.
- Context boundary with <neighbour context>: <what crosses it / what does not>.

## Domain invariants

- **DOM-NNN** — <invariant that must always hold for this concept>.
