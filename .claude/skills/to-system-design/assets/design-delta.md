<!--
  design-delta.md — the per-run record of one system-layer contribution (DOC_LIFECYCLE §macro delta).
  This is a DELTA (what THIS run reads/extends), not the system layer itself. Write one per run:
    - spec-driven : in the spec dir, beside spec.md   — fill affectedAcIds on each extend
    - top-down    : in the seed/run dir               — leave affectedAcIds empty (there is no spec)
    - reverse     : in the proposal dir               — extends = newly PROPOSED ids; add evidence
  The ```yaml core block is the machine-read part: check-system-design.ts parses reads[].elementId
  and extends[].elementId. Everything else (affectedAcIds, evidence, prose) is for humans and is
  ignored by the checker. Fill <…> and delete this comment plus any unused rows.
-->

# Design delta — <run / feature / context name>

- mode: <spec-driven | top-down | reverse>
- context(s): <ctx>
- summary: <one line — what this run added to the system layer, and why>

```yaml
# reads: existing system-layer ids this run depends on (referenced, never copied).
reads:
  - elementId: LANG-<ctx>-NNN
  - elementId: DOM-<ctx>-NNN
# extends: ids this run ADDS (additive only — never renumber/rewrite an existing id).
# In reverse mode these are the newly PROPOSED ids (the proposal check treats them as not-yet-in-_system).
extends:
  - elementId: DOM-<ctx>-NNN
    affectedAcIds: [AC-<SPEC>-NNN]   # spec-driven only — the AC(s) this element serves; omit for top-down/reverse
    evidence: "<file:symbol>"        # reverse only — where in the code this was recovered
```

## Notes (human-readable)

- <why these extends are additive; what migration they imply; what was deferred (lazy) and why>
- <reverse mode: which extends are observed-from-code vs inferred — point at findings.md for the full ledger>
