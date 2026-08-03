/** Review lenses the production runner can actually emit. */
export const REVIEW_PERSPECTIVE_KEYS = [
  'functionality',
  'codeQuality',
  'testQuality',
  'ux',
  'accessibility',
  'security',
  'type-design',
] as const;

export type ReviewPerspective = typeof REVIEW_PERSPECTIVE_KEYS[number];
