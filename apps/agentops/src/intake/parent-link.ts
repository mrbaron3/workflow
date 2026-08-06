/**
 * Parse the intake-owned Parent Link convention from a GitHub Issue body.
 *
 * Only one case-sensitive, standalone first block is authoritative. Duplicate
 * markers fail closed because an external Epic mutation must never depend on
 * choosing between conflicting parent identities.
 */
export function linkedParentIssueNumber(
  body: string,
  subjectIssueNumber?: number,
): number | null {
  const match = body.match(
    /^Parent:[ \t]*#([1-9][0-9]*)[ \t]*(?:(?:\r?\n)[ \t]*(?:\r?\n|$)|$)/,
  );
  if (!match) return null;

  const markers = body.match(/^Parent:[ \t]*#[1-9][0-9]*[ \t]*\r?$/gm) ?? [];
  if (markers.length !== 1) return null;

  const parent = Number(match[1]);
  return parent !== subjectIssueNumber ? parent : null;
}
