import fs from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { assertLiveReleaseSemanticEvidence } from '../src/evidence/live-release.js';
import { assertLiveReleaseReceiptEvidence } from '../src/evidence/release-receipt.js';
import { repositoryPath } from '../src/runtime/roots.js';

const evidencePath = process.argv[2];
if (!evidencePath) {
  throw new Error('usage: validate-live-release-evidence <evidence.json>');
}
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
  schemaVersion?: unknown;
};
const v2 = evidence.schemaVersion === '2.0';
const schema = JSON.parse(
  fs.readFileSync(
    repositoryPath(
      'contracts',
      v2 ? 'live-release-receipt.schema.json' : 'live-release-evidence.schema.json',
    ),
    'utf8',
  ),
) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
if (!validate(evidence)) {
  throw new Error(`live release evidence schema failed: ${JSON.stringify(validate.errors)}`);
}
if (v2) assertLiveReleaseReceiptEvidence(evidence);
else assertLiveReleaseSemanticEvidence(evidence);
