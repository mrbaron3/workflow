/**
 * LEGACY (pre-M20) seed planning — kept to keep the offline `agentops demo` runnable.
 *
 * This path ingests a one-shot seed file whose epics carry **issues with inline
 * acceptance criteria** (`apps/agentops/seed/sample-roadmap.yaml`). The modern main path is the
 * planning tree (`planning-tree.ts`): roadmap-planner emits outcomes only, `planRoadmap`
 * persists the tree, `spawnSpecs` materializes specs, and to-spec authors + a human
 * signs the AC — acceptance criteria never ride in on the roadmap (see
 * docs/specs/planning-tree/). Use `planFromSeedLegacy` only for the deterministic demo;
 * new wiring should go through `planRoadmap` / `spawnSpecs`.
 */

import fs from 'node:fs';
import * as YAML from 'yaml';
import { z } from 'zod';
import { Area, Epic, Issue, IssueContract, IssueType, Roadmap } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';

const SeedIssue = z.object({
  type: IssueType,
  area: Area,
  title: z.string(),
  sprint: z.string().optional(),
  contract: IssueContract,
});

const SeedEpic = z.object({
  id: z.string().optional(),
  title: z.string(),
  theme: z.string(),
  issues: z.array(SeedIssue).default([]),
});

export const SeedRoadmap = z.object({
  vision: z.string(),
  principles: z.array(z.string()).default([]),
  epics: z.array(SeedEpic).default([]),
});
export type SeedRoadmap = z.infer<typeof SeedRoadmap>;

export interface PlanResult {
  epics: number;
  issues: number;
}

export function loadSeedFile(file: string): SeedRoadmap {
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return SeedRoadmap.parse(raw);
}

export function planFromSeedLegacy(store: Store, seed: SeedRoadmap): PlanResult {
  store.setRoadmap(Roadmap.parse({ vision: seed.vision, principles: seed.principles, epicIds: [] }));

  let issues = 0;
  for (const se of seed.epics) {
    const eid = se.id ?? store.nextId('EPIC', 2);
    store.addEpic(Epic.parse({ id: eid, title: se.title, theme: se.theme, status: 'planned', issueIds: [] }));

    for (const si of se.issues) {
      const iid = store.nextId('ISSUE');
      store.addIssue(
        Issue.parse({
          id: iid,
          type: si.type,
          title: si.title,
          area: si.area,
          epicId: eid,
          sprint: si.sprint ?? null,
          status: 'planned',
          assignedAgent: null,
          contract: si.contract, // validated by IssueContract above
          createdAt: nowISO(),
          updatedAt: nowISO(),
        }),
      );
      // An issue is only "ready" once its contract has been drafted & validated.
      store.setStatus(iid, 'ready-for-contract');
      store.setStatus(iid, 'contract-drafted');
      issues++;
    }
  }
  return { epics: seed.epics.length, issues };
}

/** @deprecated Back-compat alias for the legacy demo path. Prefer `planRoadmap` (planning-tree.ts). */
export const planFromSeed = planFromSeedLegacy;
