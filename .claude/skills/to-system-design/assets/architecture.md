<!--
  architecture for one bounded context (DOC_TAXONOMY view 3 — 構造/C4·arc42). Lives at
  _system/<ctx>/architecture.md. Global within the context, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - ARCH-<CTX>-NNN ids are unique and stable within the context — never renumber/reuse.
  - PUBLIC SHAPE ONLY: signatures/contracts another unit must mesh with. No internal implementation.
  - This file feeds the (derived) component & sequence diagrams; keep seams machine-parseable.
-->

# Architecture — <context> context

## Module boundaries & seams

- **ARCH-<CTX>-NNN <module / seam>** — responsibility: <…>; public shape (signature/contract): <…>.

## Shared foundations

- **ARCH-<CTX>-NNN core/<name>** — public shape only:
  - `fn(args): ret`  <!-- meaning defined once here; internal representation left to the implementer -->

## Cross-cutting policy

- <policy that several modules must follow, e.g., how errors/time/ids are handled at seams>.

## Architecture invariants

- **ARCH-<CTX>-NNN** — <constraint that must hold across modules>.
