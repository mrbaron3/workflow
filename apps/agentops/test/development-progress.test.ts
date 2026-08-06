import { describe, expect, it } from 'vitest';
import { linkedParentIssueNumber } from '../src/intake/parent-link.js';

describe('Parent Link', () => {
  it('accepts only the canonical standalone first block', () => {
    expect(linkedParentIssueNumber('Parent: #41')).toBe(41);
    expect(linkedParentIssueNumber('Parent:\t#41  \r\n\r\nChild details.')).toBe(41);
  });

  it.each([
    'Child details.\n\nParent: #41',
    '> Parent: #41',
    '```text\nParent: #41\n```',
    'parent: #41',
    ' Parent: #41',
    'Parent: #41\nChild details without a block boundary.',
  ])('rejects incidental or non-canonical text: %s', (body) => {
    expect(linkedParentIssueNumber(body)).toBeNull();
  });

  it('rejects a self-link', () => {
    expect(linkedParentIssueNumber('Parent: #41', 41)).toBeNull();
  });

  it('fails closed when the body contains more than one parent marker', () => {
    expect(linkedParentIssueNumber('Parent: #41\n\nParent: #42')).toBeNull();
    expect(linkedParentIssueNumber(
      'Parent: #41\n\n```text\nParent: #41\n```',
    )).toBeNull();
  });
});
