# Ubiquitous language (system layer · view 1 of 4)

You fix the **ubiquitous language** of **one bounded context** — the per-context glossary every other doc
in this context (domain, architecture, data, spec) is written in. This is the first view: it fixes the
words before anything is modelled in them. Global, single-source-of-truth, additive only — read the whole
relevant glossary and add to it.

## What you write

| File (under `_system/<ctx>/`) | Element id | Holds |
| --- | --- | --- |
| `ubiquitous-language.md` | `LANG-<CTX>-NNN` | the per-context glossary every other doc references |

Template: the skill's `assets/ubiquitous-language.md`.

## Per-context, never one global dictionary

A word's meaning is bound to its context — "Order" in an ordering context is not the "Order" a shipping
context handles. So the glossary is **per-context**; domain/arch/data/spec all reference `LANG-<CTX>-NNN`
terms rather than redefining them. Cross-context translation points (the ACL) are named in `context-map.md`
when that index exists — never flattened into one dictionary.

## What earns a term (lazy / falsifiable)

Name a term only when a concept already needs a stable, shared name. The falsifiable test: *"If I omit this
term, can a future doc re-introduce the same concept under a different name?"* Yes → name it now (the
aliasing you prevent). No → defer. Don't seed a glossary with speculative vocabulary.

## Additive only

`LANG-<CTX>-NNN` ids are unique and stable within the context. To change a term's meaning you add a new
term + deprecate the old — never rewrite a definition in place (downstream docs cite it by id).

## Worked example (Todo-due, "scheduling" context, first touch)

```text
LANG-scheduling-001  "Due date" — an optional single calendar date by which a Todo is meant to be done.
LANG-scheduling-002  "Overdue"  — the derived state of a Todo whose due date is strictly before "now".
```

Not named: "reminder", "recurrence", "calendar" — no current need, and omitting them cannot cause aliasing.
Deferred (lazy).

## Reverse mode (distilling from code)

When the source is existing code, recover terms from the words the code already speaks (type/module names,
ubiquitous terms in comments and tests). Tag each with its `file:symbol` evidence; the output is a **draft
proposal** for human review, not a direct write. See [reverse.md](reverse.md).

## Hand off

The domain view ([domain.md](domain.md)) models entities in exactly these words. Record your `extends` (new
`LANG-<CTX>-NNN` ids) in the run's delta. Signal completion; do not change workflow state or sign.
