<!--
  domain-model for one bounded context (DOC_TAXONOMY view 2 — ドメイン/DDD 戦術). Lives at
  _system/<ctx>/domain-model.md. Global within the context, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - DOM-<CTX>-NNN ids are unique and stable within the context — never renumber/reuse.
  - Vocabulary comes from ubiquitous-language.md (LANG-<CTX>-NNN); reference terms, don't redefine them.
  - Write an element only if its absence makes another independent unit inconsistent.
  - This file feeds the (derived) domain diagram; keep the lists below machine-parseable.
-->

# Domain model — <context> context

## Entities & aggregates

- **DOM-<CTX>-NNN <Entity>** — identity: <what identifies it>; owns: <…>; aggregate root: <yes/no>.

## Relations & boundaries

- <EntityA> <relation> <EntityB>.
- Context boundary with <neighbour context>: <what crosses it / what does not>.

## Domain invariants, events & state

- **DOM-<CTX>-NNN** — <invariant that must always hold / domain event emitted / state transition>.
