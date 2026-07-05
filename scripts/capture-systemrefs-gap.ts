/**
 * One-shot dogfood capture: promote the systemRefs gap found while signing the
 * evaluator-panel spec into a `type:harness` backlog issue, via the Store API
 * (not a raw db.json edit). North star: a captured failure is not repeated.
 *
 * The gap: `agentops sign` (src/cli/index.ts cmdSign) never reads `dependsOn` from
 * acceptance.yaml, so ApprovedSpecRef.systemRefs is always []. Both the to-spec skill
 * and the acceptance.yaml template promise "署名時に systemRefs として版固定される".
 */
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';

const store = new Store(process.cwd());

const title = 'sign pins dependsOn as ApprovedSpecRef.systemRefs (doc-impl drift)';

if (store.db.issues.some((i) => i.title === title)) {
  console.log('already captured; no-op');
  process.exit(0);
}

const issue = Issue.parse({
  id: store.nextId('ISSUE'),
  type: 'harness',
  title,
  area: 'harness',
  epicId: null,
  featureId: null,
  specPath: null,
  sprint: null,
  status: 'planned',
  assignedAgent: null, // backlog: not opted-in to AI processing (scoping guard skips until assigned)
  contract: null,
  coversAcIds: [],
  dependsOnSystem: [],
  dependsOnIssues: [],
  implementationNotes: [
    'Found by dogfooding: signing docs/specs/evaluator-panel left systemRefs=[] despite 9 dependsOn ids.',
    'Fix seam: src/cli/index.ts cmdSign — parse dependsOn from acceptance.yaml and pass as buildApprovedSpecRef({ systemRefs }).',
    'sign.ts (pure) already accepts systemRefs; source.ts has no dependsOn parser yet — add parseDependsOn.',
    'Contract promised by: to-spec SKILL.md + assets/acceptance.yaml ("署名時に systemRefs として版固定される").',
    'Regression: after signing a spec whose acceptance.yaml has dependsOn, ApprovedSpecRef.systemRefs equals that set; changing dependsOn requires re-sign (drift).',
  ],
  createdAt: nowISO(),
  updatedAt: nowISO(),
});

store.addIssue(issue);
store.save();
console.log(`captured ${issue.id} [type:${issue.type}, status:${issue.status}] — ${issue.title}`);
