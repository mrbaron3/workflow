<!--
  architecture for one bounded context. Global, single source of truth, additive only.
  - Fill <…> and delete this comment plus any unused rows.
  - ARCH-NNN ids are unique and stable across the WHOLE system layer — never renumber/reuse.
  - PUBLIC SHAPE ONLY: signatures/contracts another unit must mesh with. No internal implementation.
  - This file feeds the (derived) component & sequence diagrams; keep seams machine-parseable.
-->

# Architecture — <context> context

## Module boundaries & seams

- **ARCH-NNN <module / seam>** — responsibility: <…>; public shape (signature/contract): <…>.

## Shared foundations

- **ARCH-NNN core/<name>** — public shape only:
  - `fn(args): ret`  <!-- meaning defined once here; internal representation left to the implementer -->

## Cross-cutting policy

- <policy that several modules must follow, e.g., how errors/time/ids are handled at seams>.

## Architecture invariants

- **ARCH-NNN** — <constraint that must hold across modules>.
