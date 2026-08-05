import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DesignBundleReviewProjectionError,
  projectDesignBundleReview,
  projectMaterializedDesignBundleReview,
  type CapabilityRequirementsReviewInput,
  type DesignBundleManifestReviewInput,
  type DesignBundleReviewInput,
  type DesignSystemDeltaReviewInput,
  type ExperienceContractReviewInput,
} from '../src/designflow/review-projection.js';

const DESIGN_EVIDENCE_ROOT = path.join(process.cwd(), 'evidence', 'ciso-05', 'design');
const CONTRACT_EXAMPLE_ROOT = path.join(
  process.cwd(),
  'contracts',
  'designflow',
  'contract-v1.0.0-rc.1',
  'contracts',
  'v1',
  'examples',
);

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function cisoBundle(revision: 'revision-01' | 'revision-02'): DesignBundleReviewInput {
  const root = path.join(DESIGN_EVIDENCE_ROOT, revision);
  return {
    manifest: readJson<DesignBundleManifestReviewInput>(
      path.join(root, 'design-bundle-manifest.json'),
    ),
    experience: readJson<ExperienceContractReviewInput>(
      path.join(root, 'experience-contract.json'),
    ),
    designSystemDelta: readJson<DesignSystemDeltaReviewInput>(
      path.join(root, 'design-system-delta.json'),
    ),
    capabilityRequirements: readJson<CapabilityRequirementsReviewInput>(
      path.join(root, 'capability-requirements.json'),
    ),
    revisionDiff: fs.readFileSync(path.join(root, 'revision-diff.md'), 'utf8'),
  };
}

function contractExampleBundle(): DesignBundleReviewInput {
  return {
    manifest: readJson<DesignBundleManifestReviewInput>(
      path.join(CONTRACT_EXAMPLE_ROOT, 'design-bundle-manifest.example.json'),
    ),
    experience: readJson<ExperienceContractReviewInput>(
      path.join(CONTRACT_EXAMPLE_ROOT, 'experience-contract.example.json'),
    ),
    designSystemDelta: readJson<DesignSystemDeltaReviewInput>(
      path.join(CONTRACT_EXAMPLE_ROOT, 'design-system-delta.example.json'),
    ),
    capabilityRequirements: readJson<CapabilityRequirementsReviewInput>(
      path.join(CONTRACT_EXAMPLE_ROOT, 'capability-requirements.example.json'),
    ),
    revisionDiff: '# Initial Designflow contract example\n\nNo previous provider revision.',
  };
}

function reverseStableSets(input: DesignBundleReviewInput): DesignBundleReviewInput {
  return {
    ...input,
    experience: {
      ...input.experience,
      pagePurposes: [...input.experience.pagePurposes].reverse().map((purpose) => ({
        ...purpose,
        sourceRequirementIds: [...purpose.sourceRequirementIds].reverse(),
      })),
      tasks: [...input.experience.tasks].reverse().map((task) => ({
        ...task,
        sourceRequirementIds: [...task.sourceRequirementIds].reverse(),
      })),
      effortBudgets: [...input.experience.effortBudgets].reverse(),
      regions: [...input.experience.regions].reverse(),
      elements: [...input.experience.elements].reverse().map((element) => ({
        ...element,
        supportsPurposeIds: [...element.supportsPurposeIds].reverse(),
        supportsTaskIds: [...element.supportsTaskIds].reverse(),
        sourceRequirementIds: [...element.sourceRequirementIds].reverse(),
      })),
      attentionHierarchies: [...input.experience.attentionHierarchies]
        .reverse()
        .map((hierarchy) => ({
          ...hierarchy,
          levels: [...hierarchy.levels].reverse().map((level) => ({
            ...level,
            regionIds: [...level.regionIds].reverse(),
            elementIds: [...level.elementIds].reverse(),
          })),
        })),
      ambiguities: [...input.experience.ambiguities].reverse(),
    },
    designSystemDelta: {
      ...input.designSystemDelta,
      decisions: [...input.designSystemDelta.decisions].reverse().map((decision) => ({
        ...decision,
        sourceRequirementIds: [...decision.sourceRequirementIds].reverse(),
      })),
      tokenDocuments: [...input.designSystemDelta.tokenDocuments].reverse(),
      componentDeltas: [...input.designSystemDelta.componentDeltas]
        .reverse()
        .map((component) => ({
          ...component,
          tokenRefs: [...component.tokenRefs].reverse(),
          sourceRequirementIds: [...component.sourceRequirementIds].reverse(),
        })),
      patternDeltas: [...input.designSystemDelta.patternDeltas].reverse().map((pattern) => ({
        ...pattern,
        sourceRequirementIds: [...pattern.sourceRequirementIds].reverse(),
      })),
    },
    capabilityRequirements: {
      ...input.capabilityRequirements,
      capabilities: [...input.capabilityRequirements.capabilities]
        .reverse()
        .map((capability) => ({
          ...capability,
          sourceInteractionIds: [...capability.sourceInteractionIds].reverse(),
          sourceRequirementIds: [...capability.sourceRequirementIds].reverse(),
          failureSemantics: [...capability.failureSemantics].reverse(),
        })),
      ambiguities: [...input.capabilityRequirements.ambiguities].reverse(),
    },
  };
}

describe('Design Bundle review projection', () => {
  it('materializes review content only from manifest-addressed digest-bound files', () => {
    const projection = projectMaterializedDesignBundleReview({
      bundleRoot: process.cwd(),
      manifestPath: 'evidence/ciso-05/design/revision-02/design-bundle-manifest.json',
      designRequestPath: 'evidence/ciso-05/design/design-request.json',
      humanDecisionPath: 'evidence/ciso-05/design/decisions/approve-r02.json',
    });

    expect(projection.elements).toHaveLength(29);
    expect(projection.revisionDiff).toContain('Workflow-authenticated lineage');
    expect(projection.revisionDiff).toContain('does not authenticate a prose revision diff');
  });

  it('projects the pinned public contract example without CISO-specific identities', () => {
    const projection = projectDesignBundleReview(contractExampleBundle());

    expect(projection.identity).toMatchObject({
      bundleId: 'design-bundle-001',
      requestId: 'design-dashboard-001',
      revisionId: 'design-revision-001',
    });
    expect(projection.elements.map((element) => element.id)).toEqual([
      'element-mode-status',
      'element-repository-row',
      'element-failure-summary',
      'element-retry-button',
    ]);
    expect(projection.capabilityDelta.map((capability) => capability.id)).toEqual([
      'cap-list-registration-status',
      'cap-retry-delivery',
    ]);
  });

  it('WF-DF-005 projects the CISO revision-02 golden bundle without requiring raw JSON', () => {
    const projection = projectDesignBundleReview(cisoBundle('revision-02'));

    expect(projection).toMatchSnapshot();
    expect(projection.elements).toHaveLength(29);
    expect(projection.elements.every((element) =>
      element.placementRationale.length > 0 && element.removalImpact.length > 0)).toBe(true);
    expect(projection.designSystemDelta.decisions).toHaveLength(14);
    expect(projection.capabilityDelta).toHaveLength(7);
    expect(projection.revisionDiff).toContain('Human change request 1');
    expect(projection.ambiguities).toEqual([]);
    expect(projection.digest.bundleDigest).toBe(
      'sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa',
    );
  });

  it('uses semantic stable ordering and returns a deeply read-only value', () => {
    const input = cisoBundle('revision-02');
    const expected = projectDesignBundleReview(input);
    const reordered = projectDesignBundleReview(reverseStableSets(input));

    expect(reordered).toEqual(expected);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.elements)).toBe(true);
    expect(Object.isFrozen(expected.elements[0])).toBe(true);
    expect(() => {
      (expected.elements[0] as { placementRationale: string }).placementRationale = 'mutated';
    }).toThrow(TypeError);
  });

  it('keeps every unresolved revision-01 ambiguity visible for human review', () => {
    const projection = projectDesignBundleReview(cisoBundle('revision-01'));

    expect(projection.ambiguities).toHaveLength(9);
    expect(projection.ambiguities.map((ambiguity) => ambiguity.source)).toEqual([
      'capability',
      'capability',
      'capability',
      'capability',
      'capability',
      'experience',
      'experience',
      'experience',
      'experience',
    ]);
    expect(projection.ambiguities.map((ambiguity) => ambiguity.text)).toMatchInlineSnapshot(`
      [
        "#13の既存capability coverageはcap-list-registration-statusとcap-retry-deliveryだけであり、本revisionのsession、create、update、disable、delivery detail各capabilityへのAPI／system／AC traceが存在しない",
        "ExecutionとQueueのactual state、freshness budget、last-good、recovery state、およびMONITOR_ONLY時の期待stateを返すcapabilityが未定義である",
        "authoritative operating modeの所有元、許可value、observed time、Control API status snapshotとの整合性契約が未定義である",
        "browser session、exact Origin、anti-CSRF、same-origin credential delivery、security headerの能力と監査境界が未定義である",
        "update／disable commandのtransport retryを二重version incrementなしで収束させるidempotency semanticsと、disable後のqueued／leased work outcome projectionが未定義である",
        "#13 Control APIにauthoritativeな全体運転modeと、そのmodeがRegistrationごとのExecution actual stateへ与える影響のprojectionが定義されていない",
        "#13 Control APIのstatus projectionはIssue Monitor、PR Monitor、Forwarderのみをcomponent actual stateとして持ち、ExecutionとQueueのdesired／actual、observedAt、last-good、stale、recovery stateが未定義である",
        "Registration create、update、disable後にDashboardがverified successを表示するためのauthoritative re-queryと、disable時の古いqueued／leased workの結果projectionが完全には定義されていない",
        "browser向けloopback sessionの確立、same-origin credential delivery、exact Origin検証、CSRF token lifecycle、security headersの契約が#13に定義されていない",
      ]
    `);
  });

  it('fails closed when an element cannot show its placement rationale', () => {
    const input = cisoBundle('revision-02');
    const first = input.experience.elements[0]!;
    const incomplete: DesignBundleReviewInput = {
      ...input,
      experience: {
        ...input.experience,
        elements: [
          { ...first, placementRationale: '   ' },
          ...input.experience.elements.slice(1),
        ],
      },
    };

    expect(() => projectDesignBundleReview(incomplete)).toThrowError(
      new DesignBundleReviewProjectionError(
        `elements.${first.id}.placementRationale is required`,
      ),
    );
  });
});
