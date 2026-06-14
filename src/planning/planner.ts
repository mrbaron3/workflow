/**
 * Roadmap + Issue planning.
 *
 * In a full deployment the Roadmap Planner and Issue Planner are *agents* that turn
 * a product goal into Epics and validated Issue Contracts (see agents/*.md). For the
 * MVP the planner ingests a human/agent-authored seed file and validates every
 * contract against the schema — which is the point: an Issue Contract is only "ready"
 * when it parses. Invalid contracts fail loudly here instead of confusing a Generator.
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

export function planFromSeed(store: Store, seed: SeedRoadmap): PlanResult {
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
