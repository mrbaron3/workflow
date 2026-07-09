/**
 * The requirement-doc filename resolver (2026-07-09 rename): new dirs author
 * `requirements.md` (the doc is a signed requirements DELTA — DOC_LIFECYCLE), legacy
 * signed dirs keep `spec.md` forever (a signature pins the committed path + blob).
 * Every reader (sign / specs / contract-draft / spawn-issues / skill checks) resolves
 * through this single home, so the era split lives in exactly one place.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requirementsDocPath, REQUIREMENTS_DOC, LEGACY_SPEC_DOC } from '../src/authoring/spec-doc.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ao-spec-doc-'));
}

describe('requirementsDocPath — one home for the era split', () => {
  it('prefers requirements.md (the modern name)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, REQUIREMENTS_DOC), '# r', 'utf8');
    fs.writeFileSync(path.join(dir, LEGACY_SPEC_DOC), '# s', 'utf8');
    expect(requirementsDocPath(dir)).toBe(path.join(dir, REQUIREMENTS_DOC));
  });

  it('falls back to the legacy spec.md when only it exists (signed dirs are never renamed)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, LEGACY_SPEC_DOC), '# s', 'utf8');
    expect(requirementsDocPath(dir)).toBe(path.join(dir, LEGACY_SPEC_DOC));
  });

  it('targets the modern name when neither exists yet (new writes get the new name)', () => {
    const dir = tmpDir();
    expect(requirementsDocPath(dir)).toBe(path.join(dir, REQUIREMENTS_DOC));
  });
});
