import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  defaultPluginDir,
  loadAllAgents,
  listAgents,
  listSkills,
  listCommands,
  loadCommand,
  loadSkillBody,
  toAgentsJson,
} from '../src/engine/promptSource.js';

const repoRoot = join(__dirname, '..');
const pluginDir = join(repoRoot, 'plugin');

const EXPECTED_AGENTS = ['explorer', 'judge', 'planner', 'researcher', 'reviewer', 'skeptic', 'verifier'];
const EXPECTED_COMMANDS = ['research', 'review', 'solve', 'verify'];
const EXPECTED_SKILLS = ['candidates', 'doctrine', 'verification-protocol'];
const READ_ONLY_AGENTS = ['explorer', 'planner', 'reviewer', 'skeptic', 'judge', 'researcher'];

describe('plugin manifests', () => {
  it('plugin.json is valid', () => {
    const schema = z.object({
      name: z.literal('fabel'),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      description: z.string().min(10),
    });
    const raw = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(() => schema.parse(raw)).not.toThrow();
  });

  it('marketplace.json points at an existing plugin dir', () => {
    const schema = z.object({
      name: z.string(),
      owner: z.object({ name: z.string() }),
      plugins: z
        .array(z.object({ name: z.string(), source: z.string(), description: z.string() }))
        .min(1),
    });
    const raw = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const parsed = schema.parse(raw);
    for (const p of parsed.plugins) {
      const dir = join(repoRoot, p.source);
      expect(existsSync(join(dir, '.claude-plugin', 'plugin.json')), `${p.source} exists`).toBe(true);
    }
  });

  it('defaultPluginDir resolves to the bundled plugin', () => {
    expect(defaultPluginDir()).toBe(pluginDir);
  });
});

describe('agents', () => {
  it('has exactly the expected agents', () => {
    expect(listAgents(pluginDir)).toEqual(EXPECTED_AGENTS);
  });

  it('every agent has valid frontmatter', () => {
    const model = z.enum(['sonnet', 'opus', 'haiku', 'inherit']);
    for (const a of loadAllAgents(pluginDir)) {
      expect(a.description.length, `${a.name} description`).toBeGreaterThan(40);
      expect(a.prompt.length, `${a.name} prompt body`).toBeGreaterThan(200);
      expect(a.tools, `${a.name} declares tools`).toBeDefined();
      if (a.model) expect(() => model.parse(a.model)).not.toThrow();
    }
  });

  it('read-only agents disallow Edit and Write, and none may spawn agents', () => {
    for (const a of loadAllAgents(pluginDir)) {
      expect(a.tools).not.toContain('Agent');
      expect(a.tools).not.toContain('Task');
      if (READ_ONLY_AGENTS.includes(a.name)) {
        expect(a.disallowedTools, `${a.name} disallowedTools`).toContain('Edit');
        expect(a.disallowedTools, `${a.name} disallowedTools`).toContain('Write');
      }
    }
  });

  it('toAgentsJson emits valid JSON keyed by agent name', () => {
    const parsed = JSON.parse(toAgentsJson(loadAllAgents(pluginDir)));
    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_AGENTS);
    for (const name of EXPECTED_AGENTS) {
      expect(parsed[name].description).toBeTruthy();
      expect(parsed[name].prompt).toBeTruthy();
      expect(Array.isArray(parsed[name].tools)).toBe(true);
    }
  });
});

describe('commands and skills (drift guard)', () => {
  it('has exactly the expected commands and skills', () => {
    expect(listCommands(pluginDir)).toEqual(EXPECTED_COMMANDS);
    expect(listSkills(pluginDir)).toEqual(EXPECTED_SKILLS);
  });

  it('every agent/skill a command references exists', () => {
    const agents = new Set(listAgents(pluginDir));
    const skills = new Set(listSkills(pluginDir));
    for (const name of listCommands(pluginDir)) {
      const cmd = loadCommand(pluginDir, name);
      expect(cmd.description.length, `${name} description`).toBeGreaterThan(20);
      // Backtick-quoted `agent` references
      for (const m of cmd.body.matchAll(/`([a-z-]+)` subagent/g)) {
        expect(agents.has(m[1]!), `command ${name} references agent ${m[1]}`).toBe(true);
      }
      // `fabel:skill` references
      for (const m of cmd.body.matchAll(/`fabel:([a-z-]+)`/g)) {
        expect(skills.has(m[1]!), `command ${name} references skill ${m[1]}`).toBe(true);
      }
    }
  });

  it('skills load and have substance', () => {
    for (const s of listSkills(pluginDir)) {
      expect(loadSkillBody(pluginDir, s).length).toBeGreaterThan(400);
    }
  });
});

describe('hooks', () => {
  it('hooks.json is valid and scripts exist and are executable', () => {
    const raw = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
    const groups = raw.hooks as Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    expect(Object.keys(groups).sort()).toEqual(['PreToolUse', 'SessionStart']);
    for (const entries of Object.values(groups)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          expect(h.type).toBe('command');
          const rel = h.command.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);
          expect(existsSync(rel), `${h.command} exists`).toBe(true);
          expect(statSync(rel).mode & 0o111, `${h.command} executable`).toBeTruthy();
        }
      }
    }
  });
});
