import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface StageRecord {
  seq: number;
  label: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  sessionId?: string;
  costUsd: number;
  error?: string;
}

export interface RunStateData {
  id: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  args?: unknown;
  stages: StageRecord[];
  summary?: unknown;
}

/**
 * Persistent per-run state under .fabel/runs/<id>/: state.json (stage graph, session
 * ids, costs) plus one raw NDJSON transcript per claude call. Enables resume,
 * post-hoc debugging, and honest cost reporting.
 */
export class RunState {
  private constructor(
    readonly dir: string,
    private data: RunStateData,
  ) {}

  static create(root: string, command: string, args?: unknown): RunState {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const id = `${stamp}-${randomBytes(2).toString('hex')}`;
    const dir = join(root, '.fabel', 'runs', id);
    mkdirSync(dir, { recursive: true });
    const state = new RunState(dir, { id, command, startedAt: new Date().toISOString(), args, stages: [] });
    state.flush();
    return state;
  }

  static load(root: string, id: string): RunState {
    const dir = join(root, '.fabel', 'runs', id);
    const file = join(dir, 'state.json');
    if (!existsSync(file)) throw new Error(`fabel: no run state at ${file}`);
    return new RunState(dir, JSON.parse(readFileSync(file, 'utf8')) as RunStateData);
  }

  static list(root: string): string[] {
    const dir = join(root, '.fabel', 'runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort();
  }

  get id(): string {
    return this.data.id;
  }

  get stages(): readonly StageRecord[] {
    return this.data.stages;
  }

  nextSeq(): number {
    return this.data.stages.length + 1;
  }

  /** Path for the raw NDJSON transcript of one claude call. */
  eventFile(seq: number, label: string): string {
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    return join(this.dir, `${String(seq).padStart(3, '0')}-${safe}.ndjson`);
  }

  recordStage(record: StageRecord): void {
    this.data.stages.push(record);
    this.flush();
  }

  totalCost(): number {
    return this.data.stages.reduce((acc, s) => acc + (s.costUsd || 0), 0);
  }

  finish(summary: unknown): void {
    this.data.finishedAt = new Date().toISOString();
    this.data.summary = summary;
    this.flush();
  }

  private flush(): void {
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(this.data, null, 2));
  }
}
