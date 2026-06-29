<!--
  Reverse-mode proposal bundle (DOC_LIFECYCLE §蒸留 / bottom-up). A STAGED draft recovered from
  existing code — NOT a write into _system/. A human reviews it and promotes the additive parts
  into _system/<ctx>/. Stage one bundle per discovered bounded context. Delete this comment when
  filling a real bundle.
-->

# System-layer proposal — distilled from code (DRAFT, awaiting human review)

Recovered from the existing implementation, not authored from a spec. Nothing here is the source of
truth until a human reviews it and promotes it into `_system/<ctx>/`. Treat every element as a
**hypothesis with evidence**, not an assertion.

## Bundle layout

```text
<proposal-dir>/
  README.md               # this file — what was distilled, from where, and what's unresolved
  context-map.md          # the bounded contexts found + DDD relationships + backing files (context-mapper)
  design-delta.md         # the machine core: `extends` = newly proposed ids, `reads` = existing _system ids depended on
  findings.md             # facts vs inferences, conflicts with authored truth, open questions
  ubiquitous-language.md  # view 1 draft — LANG-<CTX>-NNN, each with file:symbol evidence
  domain-model.md         # view 2 draft — DOM-<CTX>-NNN  (invariants the code ENFORCES, not wished ones)
  architecture.md         # view 3 draft — ARCH-<CTX>-NNN (the REAL boundaries: what depends on what)
  data-model.md           # view 4 draft — DATA-<CTX>-NNN (DBML reversed from the live schema/migrations)
```

The four view drafts use the same templates as forward mode (`assets/ubiquitous-language.md`,
`domain-model.md`, `architecture.md`, `data-model.md`) — the only differences are the `file:symbol`
evidence tag on each element and the DRAFT status of the whole bundle.

## Check (proposal mode)

```bash
npx tsx ${CLAUDE_SKILL_DIR}/scripts/check-system-design.ts <proposal-dir> --proposal --system <ctx-system-dir>
```

Verifies the proposal is **additive** (no proposed id collides with an existing `_system` element) and
that its `reads` resolve. No spec linkage is required or checked.

## Promotion (human, after review)

The reviewer confirms or rejects each element, resolves the open questions in `findings.md`, and merges the
confirmed, additive parts into `_system/<ctx>/`. Conflicts (code contradicting authored truth) are decided
deliberately — they are findings, never silently overwritten.
