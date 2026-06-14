/**
 * CliAgentRunner — wires a real coding-agent CLI (Claude Code / Codex / Gemini)
 * into the loop.
 *
 * SCAFFOLD NOTE: full-fidelity real-agent runs require the agent to operate on an
 * actual target repository and the graders to run real commands (npm test,
 * playwright, ...) against that checkout. That target-repo wiring is intentionally
 * out of scope for this MVP — see docs/ROADMAP.md (v2). What this runner does today:
 * render the Generator role prompt + the Issue Contract, invoke the configured CLI,
 * and parse a BuildArtifact JSON block from its output. If the tool isn't installed
 * or doesn't return a parseable artifact, it fails loudly (rather than silently
 * pretending to have built something).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import * as YAML from 'yaml';
import type { AgentCliConfig } from '../config.js';
import type { AgentRunner } from './runner.js';
import type { BuildArtifact, GenerateInput } from '../domain/artifact.js';
import type { GeneratorAgent } from '../domain/schema.js';
import { loadRolePrompt } from './prompts.js';

const ArtifactSchema = z.object({
  branch: z.string().default('agent/work'),
  summary: z.string().default(''),
  filesChanged: z.array(z.string()).default([]),
  satisfied: z.record(z.boolean()).default({}),
  buildPasses: z.boolean().default(false),
  typecheckPasses: z.boolean().default(false),
  unitTestsPass: z.boolean().default(false),
  apiTestsPass: z.boolean().default(false),
  hasTests: z.boolean().default(false),
  secretsLeaked: z.boolean().default(false),
  scopeViolations: z.array(z.string()).default([]),
  quality: z
    .object({
      codeQuality: z.number().default(0.5),
      testQuality: z.number().default(0.5),
      ux: z.number().default(0.5),
      accessibility: z.number().default(0.5),
    })
    .default({ codeQuality: 0.5, testQuality: 0.5, ux: 0.5, accessibility: 0.5 }),
  notes: z.array(z.string()).default([]),
});

export class CliAgentRunner implements AgentRunner {
  readonly agent: GeneratorAgent;
  private readonly cfg: AgentCliConfig;

  constructor(agent: GeneratorAgent, cfg: AgentCliConfig) {
    this.agent = agent;
    this.cfg = cfg;
  }

  async generate(input: GenerateInput): Promise<BuildArtifact> {
    const prompt = this.renderPrompt(input);

    const tmpFile = path.join(
      os.tmpdir(),
      `agentops-prompt-${input.issue.id}-s${input.sampleIndex}-a${input.attempt}.md`,
    );
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    const args = this.cfg.args.map((a) =>
      a.replace('{promptFile}', tmpFile).replace('{prompt}', prompt),
    );

    const res = spawnSync(this.cfg.command, args, {
      encoding: 'utf8',
      timeout: 1000 * 60 * 20,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (res.error) {
      throw new Error(
        `Failed to launch "${this.cfg.command}": ${res.error.message}. ` +
          `Is the ${this.agent} CLI installed and on PATH? ` +
          `(Set "generator": "mock" in .harness/config.json to run offline.)`,
      );
    }
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const artifact = this.parseArtifact(out);
    if (!artifact) {
      throw new Error(
        `${this.agent} did not return a parseable BuildArtifact JSON block. ` +
          `Raw output saved alongside prompt at ${tmpFile}. See agents/generator.md ` +
          `for the required output contract.`,
      );
    }
    return artifact;
  }

  private renderPrompt(input: GenerateInput): string {
    const role = loadRolePrompt('generator');
    const contractYaml = YAML.stringify(input.contract);
    const repair = input.repairBrief
      ? `\n## Repair brief (fix exactly these)\n${YAML.stringify(input.repairBrief)}`
      : '';
    return [
      role,
      `\n## Issue\n${input.issue.id} — ${input.issue.title} (area: ${input.issue.area})`,
      `\n## Issue Contract\n\`\`\`yaml\n${contractYaml}\`\`\``,
      repair,
      `\n## Required output\nAfter doing the work, emit a single fenced \`json\` block`,
      `matching the BuildArtifact shape documented in agents/generator.md.`,
    ].join('\n');
  }

  private parseArtifact(output: string): BuildArtifact | null {
    const fence = output.match(/```json\s*([\s\S]*?)```/i);
    const jsonText = fence?.[1] ?? this.extractLastObject(output);
    if (!jsonText) return null;
    try {
      const parsed = ArtifactSchema.parse(JSON.parse(jsonText));
      return parsed as BuildArtifact;
    } catch {
      return null;
    }
  }

  private extractLastObject(s: string): string | null {
    const start = s.lastIndexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    return s.slice(start, end + 1);
  }
}
