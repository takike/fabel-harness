import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

/**
 * Single source of truth bridge: parses the plugin's markdown (agents, skills,
 * commands) so the CLI runs the exact same personas interactive sessions get.
 */

export interface AgentDef {
  name: string;
  description: string;
  /** Markdown body = the agent's system prompt. */
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  maxTurns?: number;
}

export interface CommandDef {
  name: string;
  description: string;
  body: string;
}

function splitList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim());
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve the bundled plugin directory: works from src (tests) and dist (published). */
export function defaultPluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/engine/ or dist/engine/ → repo/package root is two levels up.
  const root = join(here, '..', '..');
  const candidate = join(root, 'plugin');
  if (existsSync(join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
  throw new Error(`fabel: bundled plugin directory not found at ${candidate}`);
}

export function loadAgent(pluginDir: string, name: string): AgentDef {
  const file = join(pluginDir, 'agents', `${name}.md`);
  const { data, content } = matter(readFileSync(file, 'utf8'));
  const agentName = typeof data.name === 'string' ? data.name : name;
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error(`fabel: agent ${name} has no description frontmatter`);
  }
  return {
    name: agentName,
    description: data.description,
    prompt: content.trim(),
    tools: splitList(data.tools),
    disallowedTools: splitList(data.disallowedTools),
    model: typeof data.model === 'string' ? data.model : undefined,
    effort: typeof data.effort === 'string' ? data.effort : undefined,
    maxTurns: typeof data.maxTurns === 'number' ? data.maxTurns : undefined,
  };
}

export function listAgents(pluginDir: string): string[] {
  return readdirSync(join(pluginDir, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function loadAllAgents(pluginDir: string): AgentDef[] {
  return listAgents(pluginDir).map((n) => loadAgent(pluginDir, n));
}

/** Build the value for `claude --agents '<json>'` from agent defs. */
export function toAgentsJson(agents: AgentDef[]): string {
  const out: Record<string, unknown> = {};
  for (const a of agents) {
    out[a.name] = {
      description: a.description,
      prompt: a.prompt,
      ...(a.tools ? { tools: a.tools } : {}),
      ...(a.disallowedTools ? { disallowedTools: a.disallowedTools } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
    };
  }
  return JSON.stringify(out);
}

export function listSkills(pluginDir: string): string[] {
  const dir = join(pluginDir, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Skill body text (frontmatter stripped) — appended to worker system prompts. */
export function loadSkillBody(pluginDir: string, name: string): string {
  const file = join(pluginDir, 'skills', name, 'SKILL.md');
  return matter(readFileSync(file, 'utf8')).content.trim();
}

export function listCommands(pluginDir: string): string[] {
  return readdirSync(join(pluginDir, 'commands'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function loadCommand(pluginDir: string, name: string): CommandDef {
  const file = join(pluginDir, 'commands', `${name}.md`);
  const { data, content } = matter(readFileSync(file, 'utf8'));
  return {
    name,
    description: typeof data.description === 'string' ? data.description : '',
    body: content.trim(),
  };
}
