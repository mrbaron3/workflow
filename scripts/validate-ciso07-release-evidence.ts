import fs from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { assertCiso07SemanticEvidence } from '../src/evidence/ciso07.js';

const evidencePath = process.argv[2];
if (!evidencePath) {
  throw new Error('usage: validate-ciso07-release-evidence <evidence.json>');
}
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as object;
const schema = JSON.parse(
  fs.readFileSync('contracts/ciso-07-release-evidence.schema.json', 'utf8'),
) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
if (!validate(evidence)) {
  throw new Error(`CISO-07 evidence schema failed: ${JSON.stringify(validate.errors)}`);
}
assertCiso07SemanticEvidence(evidence);
