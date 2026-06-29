<!--
  The honesty ledger for a reverse-mode proposal. Machine extraction recovers structure, not
  judgment — so keep what you OBSERVED separate from what you INFERRED, and surface anything a
  reviewer must decide. Fill <…> and delete this comment plus any unused rows.
-->

# Findings — distilled from code (for human review)

## Observed (facts — directly read from the code)

Each is verifiable at the cited location; a reviewer should be able to confirm it without judgment.

- **<element id>** — <what was observed> — evidence: `<file>:<symbol/line>`.

## Inferred (hypotheses — judgment a human must confirm)

Plausible from the code but not stated by it (e.g. "this is the aggregate root", "this guard encodes an
intentional invariant"). Confirm or reject before promoting.

- **<element id>** — <the inference> — based on: `<file>:<symbol>` — confidence: <low/med/high>.

## Conflicts with existing authored truth

Where the code contradicts what `_system/<ctx>/` already asserts. A conflict is a decision for the human,
never a silent overwrite.

- **<existing id>** asserts <X>, but the code does <Y> — evidence: `<file>:<symbol>`. Drift to resolve.

## Open questions

What the code cannot answer (the *why*, the intended-vs-accidental, the dead code).

- <question the reviewer needs to settle before this becomes SSOT>.
