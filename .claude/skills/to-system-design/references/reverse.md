# Reverse mode — distilling the system layer from existing code

Use this when the source is an **existing implementation**, not a spec or a requirement (DOC_LIFECYCLE
§蒸留 / bottom-up). You read the code and recover the four system-layer views *as a draft proposal* — the
"system that already is", reconstructed from how it actually behaves. This is what lets a system design
exist for a codebase that was never spec-driven.

## The cardinal rule: a draft, never a direct write

Reverse output is a **proposal for human review**, staged outside `_system/`, never a direct mutation of
it. The additive SSOT (`_system/<ctx>/`) is built from human judgment — an invariant's rationale, a term's
agreed meaning, the *why* of a decision. Machine extraction recovers structure, not judgment, so it must not
silently overwrite authored truth. A human reviews the proposal and promotes it (additively) into `_system/`.
Stage it using the skill's `assets/proposal/` layout.

## Order of work

1. **Context discovery first** (the `context-mapper` persona). Before any view, infer the bounded contexts
   and their seams from the code's real structure — module/package boundaries, deployment units, database
   schemas, API/event surfaces, and where one area translates another's vocabulary (ACL). Emit a
   `context-map` note: the contexts, their DDD relationships, and which files back each. This decides *how
   many* `_system/<ctx>/` proposals you produce.
2. **Then the four views, per context**, in the same dependency order as forward mode
   (language → domain → {architecture ∥ data}):
   - **Language** ← the domain vocabulary actually used in names (types, modules, terms in code/comments/
     tests). Recover `LANG` from the words the code already speaks.
   - **Domain** ← entities/aggregates and the **invariants the code actually enforces** (validations,
     guards, state transitions, unique constraints). Recover `DOM` from enforced rules, not wished ones.
   - **Architecture** ← the **real** module boundaries, seams, and public signatures (exports, interfaces,
     routes). Recover `ARCH` from what actually depends on what.
   - **Data** ← the **real** persistence: reverse the DBML from the live schema / migrations / ORM models,
     then derive the ER diagram. This is the most faithful view — the database doesn't lie.

## Facts vs. inferences (the honesty discipline)

Tag every proposed element with **evidence** — the `file:symbol` it was read from — so a reviewer can
verify it. Separate what you **observed** (a column exists, a guard throws) from what you **inferred** (this
is an aggregate root, this invariant is intentional). Inferences are hypotheses for the human to confirm —
surface them as open questions, don't launder them into asserted truth.

## Reconciling with an existing system layer

If `_system/<ctx>/` already has authored content, do not duplicate or overwrite it. Produce **additive**
proposals for what is genuinely new, and **flag conflicts** where the code contradicts the authored truth
(e.g. an invariant the docs assert but the code doesn't enforce). A conflict is a finding for the human, not
a thing to silently reconcile — the drift itself is valuable signal.

## Output / signal

A proposal bundle (the four view drafts + the `context-map` note + a facts-vs-inferences `findings.md` with
open questions and conflicts + a `design-delta.md` whose `extends` are the newly proposed ids and `reads`
are the existing `_system` ids depended on), staged for review. Run the deterministic check in proposal
mode:

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-system-design.ts <proposal-dir> --proposal --system <ctx-system-dir>
```

It verifies the proposal is additive (no id collides with existing `_system`) and its `reads` resolve — no
spec linkage required. Signal completion; the human reviews and promotes. You do not write `_system/`
directly and do not sign.
