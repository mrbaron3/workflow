import fs from 'node:fs';
import path from 'node:path';

import type { DesignRequest } from '../../src/domain/schema.js';
import {
  digestDesignflowArtifact,
  digestDesignflowManifest,
  type DesignflowBundleInput,
} from '../../src/designflow/contract-consumer.js';

const EXAMPLE_ROOT = path.resolve(
  process.cwd(),
  'contracts/designflow/contract-v1.0.0-rc.1/contracts/v1/examples',
);

export const GENERIC_CAPABILITY_IDS = [
  'cap-export-report',
  'cap-view-report-summary',
] as const;

export const GENERIC_REVISION_IDS = {
  requestChanges: 'report-workspace-r01',
  approved: 'report-workspace-r02',
} as const;

export const GENERIC_DECISION_IDS = {
  requestChanges: 'report-workspace-r01-request-changes',
  approved: 'report-workspace-r02-approve',
} as const;

export interface GenericBundleFixture {
  readonly input: DesignflowBundleInput;
  readonly revisionId: string;
  readonly decisionId: string;
  readonly bundleDigest: string;
  readonly root: string;
}

function readExample(fileName: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(path.join(EXAMPLE_ROOT, fileName), 'utf8'),
  ) as Record<string, any>;
}

function replaceExactStrings(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((nested) => replaceExactStrings(nested, replacements));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        replaceExactStrings(nested, replacements),
      ]),
    );
  }
  return value;
}

function writeJson(root: string, fileName: string, value: unknown): void {
  fs.writeFileSync(
    path.join(root, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Materialize a provider-neutral standard-intake bundle in a caller-owned temporary directory.
 * Nothing in the fixture path or identity is tied to the historical CISO evidence.
 */
export function createGenericBundleFixture(
  parent: string,
  request: DesignRequest,
  revision: 1 | 2,
): GenericBundleFixture {
  const revisionId = revision === 1
    ? GENERIC_REVISION_IDS.requestChanges
    : GENERIC_REVISION_IDS.approved;
  const decisionId = revision === 1
    ? GENERIC_DECISION_IDS.requestChanges
    : GENERIC_DECISION_IDS.approved;
  const root = path.join(parent, `provider-output-${revision}`);
  fs.mkdirSync(root, { recursive: true });

  const replacements = new Map<string, string>([
    ['design-dashboard-001', request.requestId],
    ['design-revision-001', revisionId],
    ['REQ-DASH-001', 'REQ-REPORT-001'],
    ['REQ-DASH-002', 'REQ-REPORT-002'],
    ['REQ-DASH-003', 'REQ-REPORT-003'],
    ['cap-list-registration-status', 'cap-view-report-summary'],
    ['cap-retry-delivery', 'cap-export-report'],
    ['interaction-view-status', 'interaction-view-report'],
    ['interaction-open-failure', 'interaction-inspect-report'],
    ['interaction-retry-delivery', 'interaction-export-report'],
    ['purpose-control-dashboard', 'purpose-report-workspace'],
    ['task-diagnose-repository', 'task-review-report'],
    ['task-retry-delivery', 'task-export-report'],
    ['flow-diagnose', 'flow-review-report'],
    ['flow-retry-delivery', 'flow-export-report'],
    ['region-global-status', 'region-report-summary'],
    ['region-repository-list', 'region-report-details'],
    ['region-failure-detail', 'region-report-actions'],
    ['element-mode-status', 'element-report-heading'],
    ['element-repository-row', 'element-report-summary'],
    ['element-failure-summary', 'element-export-status'],
    ['element-retry-button', 'element-export-button'],
  ]);

  const experience = replaceExactStrings(
    readExample('experience-contract.example.json'),
    replacements,
  ) as Record<string, any>;
  experience.ambiguities = revision === 1
    ? ['The export confirmation feedback is not yet explicit']
    : [];
  experience.pagePurposes[0].name = 'Report workspace';
  experience.pagePurposes[0].primaryPurpose =
    'Let an analyst understand the current report and export it without losing context';
  experience.pagePurposes[0].successOutcome =
    'The summary, export action, and result remain understandable in one workspace';
  experience.pagePurposes[0].secondaryPurposes = [
    'Confirm the current report revision before export',
  ];
  experience.pagePurposes[0].outOfScope = [
    'Editing report source records',
    'Running arbitrary commands',
  ];
  experience.tasks[0].goal = 'Review the current report summary';
  experience.tasks[1].goal = 'Export the current report';
  experience.flows[0].name = 'Report summary review';
  experience.flows[0].steps[0].actorAction = 'Open the report workspace';
  experience.flows[0].steps[0].systemResponse =
    'Show the current report heading and summary';
  experience.flows[0].steps[0].resultingState = 'report-summary-visible';
  experience.flows[0].steps[1].actorAction = 'Inspect the report summary';
  experience.flows[0].steps[1].systemResponse =
    'Keep key values and their observed revision visible';
  experience.flows[0].steps[1].resultingState = 'report-reviewed';
  experience.flows[1].name = 'Report export';
  experience.flows[1].steps[0].actorAction = 'Activate Export report';
  experience.flows[1].steps[0].systemResponse =
    'Start one export and announce its status beside the action';
  experience.flows[1].steps[0].resultingState = 'report-export-started';
  experience.effortBudgets[0].rationale =
    'The report summary is visible without navigation or repeated input';
  experience.effortBudgets[1].rationale =
    'One direct action starts export and feedback remains in the same context';
  experience.regions[0].purpose = 'Identify the current report';
  experience.regions[0].groupingRationale =
    'The report identity precedes its summary and actions';
  experience.regions[0].responsiveBehavior =
    'Keep the full report heading visible at every supported width';
  experience.regions[1].purpose = 'Present the current report summary';
  experience.regions[1].groupingRationale =
    'Related summary values remain in one scannable group';
  experience.regions[1].responsiveBehavior =
    'Stack summary labels and values without horizontal scrolling';
  experience.regions[2].purpose = 'Start export and report its result';
  experience.regions[2].groupingRationale =
    'The export action and feedback stay adjacent';
  experience.regions[2].responsiveBehavior =
    'Keep the action and complete status message visible on narrow screens';
  experience.elements[0].label = 'Current report';
  experience.elements[0].visibleWhen = 'a report is selected';
  experience.elements[0].placementRationale =
    'The report heading establishes context before data and actions';
  experience.elements[0].interactionRationale =
    'The heading is read-only context for every following task';
  experience.elements[0].removalImpact =
    'Analysts cannot confirm which report they are viewing';
  experience.elements[1].placementRationale =
    'The summary follows its heading so key values can be scanned directly';
  experience.elements[1].label = 'Report summary';
  experience.elements[1].visibleWhen = 'the current report is available';
  experience.elements[1].interactionRationale =
    'The summary exposes current values without requiring navigation';
  experience.elements[1].removalImpact =
    'Analysts cannot understand the report before exporting it';
  experience.elements[2].placementRationale =
    'Export feedback stays adjacent to the action that caused it';
  experience.elements[2].label = 'Export status';
  experience.elements[2].visibleWhen = 'the export state is known';
  experience.elements[2].interactionRationale =
    'A polite live region announces status without moving focus';
  experience.elements[2].removalImpact =
    'Analysts cannot tell whether an export started or failed';
  experience.elements[3].placementRationale =
    'The export action follows the summary and remains in the primary task flow';
  experience.elements[3].label = 'Export report';
  experience.elements[3].visibleWhen = 'the current report may be exported';
  experience.elements[3].interactionRationale =
    'One keyboard or pointer activation starts an idempotent export';
  experience.elements[3].removalImpact =
    'Analysts cannot export the report from the workspace';
  experience.attentionHierarchies[0].levels[0].reason =
    'Report identity and summary establish the decision context first';
  experience.attentionHierarchies[0].levels[1].reason =
    'Export status and action follow after the report is understood';

  const designSystemDelta = replaceExactStrings(
    readExample('design-system-delta.example.json'),
    replacements,
  ) as Record<string, any>;
  designSystemDelta.baseRevisionRef = null;
  designSystemDelta.decisions[0].rationale =
    'The existing alert pattern provides accessible export feedback';
  designSystemDelta.decisions[1].rationale =
    'The existing summary card is extended with export status';
  designSystemDelta.decisions[2].rationale =
    'A semantic status token keeps feedback consistent across report surfaces';
  designSystemDelta.componentDeltas[0].name = 'Report Summary Card';
  designSystemDelta.componentDeltas[0].purpose =
    'Present current report values, revision, and export status together';
  designSystemDelta.componentDeltas[0].variants = ['ready', 'exporting', 'failed'];
  designSystemDelta.componentDeltas[0].states = [
    'default',
    'loading',
    'exporting',
    'failed',
  ];
  designSystemDelta.componentDeltas[0].slots = [
    'report-name',
    'summary-values',
    'observed-revision',
    'export-status',
  ];
  designSystemDelta.componentDeltas[0].keyboardBehavior =
    'The summary is static and the adjacent export button follows normal tab order';
  designSystemDelta.componentDeltas[0].focusBehavior =
    'Starting export keeps focus on the button and announces status politely';
  designSystemDelta.componentDeltas[0].responsiveRules = [
    'Stack labels and values at narrow widths',
    'Never truncate the export status message',
  ];
  designSystemDelta.componentDeltas[0].contentConstraints = [
    'Do not communicate status by color alone',
    'Keep the report name distinguishable',
  ];
  designSystemDelta.patternDeltas[0].name = 'Report Export Feedback';
  designSystemDelta.patternDeltas[0].purpose =
    'Keep the export action, progress, result, and retry guidance in one context';
  designSystemDelta.patternDeltas[0].compositionRules = [
    'Place export feedback next to the action',
    'Announce status changes with a polite live region',
    'Keep detailed diagnostics behind progressive disclosure',
  ];

  const capabilityRequirements = replaceExactStrings(
    readExample('capability-requirements.example.json'),
    replacements,
  ) as Record<string, any>;
  capabilityRequirements.capabilities[0].userIntent =
    'View the current report summary';
  capabilityRequirements.capabilities[0].successOutcome =
    'The current report summary and observed revision are returned';
  Object.assign(capabilityRequirements.capabilities[0], {
    inputDescription: 'Authenticated analyst context and current report identity',
    failureSemantics: [{
      condition: 'The report summary cannot be loaded',
      userVisibleOutcome: 'Show that the summary is unavailable and retain the last observed time',
      recoverability: 'Allow an explicit bounded refresh',
    }],
    authorization: 'Only analysts allowed to read the report may view its summary',
    latencyExpectation: 'Expose a loading state and update the same summary region',
    freshnessExpectation: 'Return the observed report revision and never label stale data current',
    concurrencySemantics: 'Each response represents one coherent report revision',
    idempotencySemantics: 'The query is read-only',
    retrySemantics: 'Transient reads may retry within a bounded budget',
    cancellationSemantics: 'A newer report selection cancels application of older results',
    paginationSemantics: 'Not applicable to the single current report summary',
    auditSemantics: 'Record access failures without storing report secrets',
  });
  capabilityRequirements.capabilities[1].userIntent =
    'Export the current report';
  capabilityRequirements.capabilities[1].successOutcome =
    'A single export job starts and its status is returned';
  Object.assign(capabilityRequirements.capabilities[1], {
    inputDescription: 'Current report identity, observed revision, and idempotency key',
    failureSemantics: [{
      condition: 'The observed report revision is stale',
      userVisibleOutcome: 'Do not start export and ask the analyst to refresh',
      recoverability: 'Refresh the summary and retry explicitly',
    }],
    authorization: 'Only analysts allowed to export the report may start an export',
    latencyExpectation: 'Acknowledge the export job immediately and expose progress',
    freshnessExpectation: 'Validate the observed report revision immediately before export',
    concurrencySemantics: 'Concurrent identical requests create at most one export job',
    idempotencySemantics: 'The same key returns the same export job',
    retrySemantics: 'Transport retries reuse the idempotency key',
    cancellationSemantics: 'Cancellation state is explicit and never reported as success',
    paginationSemantics: 'Not applicable',
    auditSemantics: 'Record actor, report, revision, export job, and time',
  });
  capabilityRequirements.ambiguities = [];

  const tokenBytes = fs.readFileSync(path.join(EXAMPLE_ROOT, 'dashboard.tokens.json'));
  fs.writeFileSync(path.join(root, 'report.tokens.json'), tokenBytes);
  designSystemDelta.tokenDocuments[0].path = 'report.tokens.json';
  designSystemDelta.tokenDocuments[0].digest = digestDesignflowArtifact(
    tokenBytes,
    'application/design-tokens+json',
  );
  designSystemDelta.tokenDocuments[0].purpose =
    'Semantic report summary and export feedback tokens';

  const preview = [
    '<!doctype html>',
    '<html lang="en"><meta charset="utf-8"><title>Report workspace preview</title>',
    '<main><h1>Quarterly report</h1><p>Summary is ready.</p>',
    '<button type="button">Export report</button>',
    '<p role="status" aria-live="polite">Ready to export.</p></main></html>',
  ].join('');
  fs.writeFileSync(path.join(root, 'preview.html'), preview, 'utf8');
  writeJson(root, 'design-request.json', request);
  writeJson(root, 'experience-contract.json', experience);
  writeJson(root, 'design-system-delta.json', designSystemDelta);
  writeJson(root, 'capability-requirements.json', capabilityRequirements);

  const artifact = (
    fileName: string,
    mediaType: string,
    schemaRef: string,
  ) => ({
    path: fileName,
    digest: digestDesignflowArtifact(
      fs.readFileSync(path.join(root, fileName)),
      mediaType,
    ),
    mediaType,
    schemaRef,
  });
  const manifest: Record<string, any> = {
    schemaVersion: '1.0',
    bundleId: `report-workspace-bundle-r0${revision}`,
    requestId: request.requestId,
    revisionId,
    previousRevisionId: revision === 1 ? null : GENERIC_REVISION_IDS.requestChanges,
    sourceDigest: digestDesignflowArtifact(
      Buffer.from(JSON.stringify(request), 'utf8'),
      'application/json',
    ),
    designSystemBaseRevision: null,
    artifacts: {
      experience: artifact(
        'experience-contract.json',
        'application/json',
        'urn:designflow:schema:v1:experience-contract',
      ),
      designSystemDelta: artifact(
        'design-system-delta.json',
        'application/json',
        'urn:designflow:schema:v1:design-system-delta',
      ),
      designTokens: artifact(
        'report.tokens.json',
        'application/design-tokens+json',
        'https://www.designtokens.org/TR/2025.10/format/',
      ),
      capabilityRequirements: artifact(
        'capability-requirements.json',
        'application/json',
        'urn:designflow:schema:v1:capability-requirements',
      ),
      preview: artifact('preview.html', 'text/html', 'none'),
    },
    authorInvocationRefs: [{
      provider: 'fixture',
      externalId: `report-workspace-author-r0${revision}`,
      revision: String(revision),
    }],
    bundleDigest: '',
    createdAt: `2026-07-28T0${revision}:30:00.000Z`,
  };
  manifest.bundleDigest = digestDesignflowManifest(manifest);
  writeJson(root, 'design-bundle-manifest.json', manifest);

  const decision = {
    schemaVersion: '1.0',
    decisionId,
    requestId: request.requestId,
    revisionId,
    bundleDigest: manifest.bundleDigest,
    verdict: revision === 1 ? 'request-changes' : 'approve',
    rationale: revision === 1
      ? 'Make export feedback explicit before implementation'
      : 'Purpose, effort, attention, rationale, and export feedback are complete',
    decidedBy: {
      provider: 'fixture-human',
      subject: 'product-owner',
      displayName: 'Product owner',
    },
    decidedAt: `2026-07-28T0${revision}:45:00.000Z`,
    supersedesDecisionId: revision === 1
      ? null
      : GENERIC_DECISION_IDS.requestChanges,
  };
  writeJson(root, 'human-design-decision.json', decision);

  return {
    input: {
      bundleRoot: root,
      manifestPath: 'design-bundle-manifest.json',
      designRequestPath: 'design-request.json',
      humanDecisionPath: 'human-design-decision.json',
    },
    revisionId,
    decisionId,
    bundleDigest: manifest.bundleDigest,
    root,
  };
}
