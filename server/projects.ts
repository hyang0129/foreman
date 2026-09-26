import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FOREMAN_HOME } from './paths.ts';

export interface Project { id: string; name: string; path: string; canonicalPath: string; registeredPaths?: string[]; aliases: string[]; lastUsed: string | null }
export type ProjectResolution = { status: 'resolved'; path: string; project?: Project } | { status: 'ambiguous' | 'not_found'; candidates: Project[] };
const key = (value: string) => value.trim().toLocaleLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${field} must contain 1–200 characters`);
  return value.trim();
}
export function readableDirectory(path: string, pinned?: string): string {
  if (!isAbsolute(path)) throw new Error('Project directory must be an existing absolute directory');
  let canonical: string;
  try {
    canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error();
    accessSync(canonical, constants.R_OK | constants.X_OK);
  } catch { throw new Error(`Project directory is missing or unreadable: ${path}`); }
  if (pinned && canonical !== pinned) throw new Error(`Project directory changed its symlink target: ${path}. Remove and register it again to choose the new directory.`);
  return canonical;
}

/** Where seed() never auto-registers (#234). Tests override `tmp`, since their fixtures live under it. */
export interface SeedRoots { tmp: string[]; home: string; state: string[] }
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
export function seedRoots(override: Partial<SeedRoots> = {}): SeedRoots {
  const tmp = tmpdir();
  return { tmp: [tmp, real(tmp), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'], home: homedir(), state: [FOREMAN_HOME, real(FOREMAN_HOME)], ...override };
}
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** The main checkout owning a linked git worktree at `dir`, or null (not a worktree, or a bare repo's). */
function worktreeOwner(dir: string): string | null {
  try {
    const match = /^gitdir: (.+)$/m.exec(readFileSync(join(dir, '.git'), 'utf8')); if (!match) return null;
    const gitdir = resolve(dir, match[1].trim()); if (basename(dirname(gitdir)) !== 'worktrees') return null;
    let common: string;
    try { common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()); } catch { common = dirname(dirname(gitdir)); }
    if (/^\s*bare\s*=\s*true\s*$/m.test(readFileSync(join(common, 'config'), 'utf8'))) return null;
    return real(dirname(common));
  } catch { return null; }
}
/**
 * True for a session cwd that is not a project root: a linked git worktree of a registered repo
 * (`registered(mainCheckout)`), anything under `.claude/worktrees/`, a temp directory, $HOME
 * itself, or Foreman state (FOREMAN_HOME, `~/.foreman*`). Worktrees of a bare repo, or of a repo
 * not registered, are projects. Checks the lexical and the canonical path. register() does not consult it.
 */
export function notAProject(path: string, roots: SeedRoots = seedRoots(), registered: (path: string) => boolean = () => false): boolean {
  const canonical = real(path), homes = [roots.home, real(roots.home)], owner = worktreeOwner(canonical);
  if (owner && registered(owner)) return true;
  return [path, canonical].some((p) => {
    const parts = p.split(sep);
    return parts.some((part, i) => part === '.claude' && parts[i + 1] === 'worktrees')
      || [...roots.tmp, ...roots.state].some((root) => within(p, root))
      || homes.some((home) => p === home || (within(p, home) && relative(home, p).split(sep)[0].startsWith('.foreman')));
  });
}

/** Owner-local names. Lexical paths and their canonical targets are retained together. */
export class ProjectRegistry {
  private entries: Project[] = [];
  private removed: string[] = [];
  private file: string;
  private roots: SeedRoots;
  constructor(home = FOREMAN_HOME, roots = seedRoots()) {
    this.roots = roots; mkdirSync(home, { recursive: true, mode: 0o700 }); this.file = join(home, 'projects.json');
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.removed)) throw new Error('Invalid project registry');
      this.entries = data.projects; this.removed = data.removed;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  private save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, projects: this.entries, removed: this.removed }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, this.file);
  }
  list(): Project[] { return structuredClone(this.entries).sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.name.localeCompare(b.name)); }
  forPath(path: string | null | undefined) { return this.entries.find((p) => p.path === path || p.canonicalPath === path || !!path && p.registeredPaths?.includes(path)); }
  private isRegistered = (path: string) => !!this.forPath(path);
  register(input: { name: string; path: string; aliases?: string[] }): Project {
    const name = label(input.name, 'Project name');
    if (typeof input.path !== 'string' || input.path.length > 4096) throw new Error('Project path must be an absolute directory');
    const path = normalize(input.path), prior = this.forPath(path);
    const canonicalPath = readableDirectory(path, prior?.canonicalPath);
    const existing = prior ?? this.entries.find((p) => p.canonicalPath === canonicalPath);
    if (existing) this.validate(existing);
    if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 30)) throw new Error('Aliases must be a list of at most 30 names');
    const aliases = (input.aliases ?? []).map((a) => label(a, 'Alias'));
    if (existing) {
      const nextAliases = [...new Set([...existing.aliases, ...(key(name) !== key(existing.name) ? [name] : []), ...aliases])];
      if (nextAliases.length > 30) throw new Error('A project may have at most 30 aliases');
      existing.aliases = nextAliases; existing.registeredPaths = [...new Set([...(existing.registeredPaths ?? [existing.path]), path])];
      this.save(); return structuredClone(existing);
    }
    if (this.entries.length >= 500) throw new Error('Project registry limit reached');
    const project: Project = { id: randomUUID(), name, path, canonicalPath, registeredPaths: [path], aliases: [...new Set(aliases)], lastUsed: null };
    this.entries.push(project); this.removed = this.removed.filter((p) => p !== path && p !== canonicalPath); this.save();
    return structuredClone(project);
  }
  update(id: string, name: string, aliases?: string[]): Project {
    const project = this.entries.find((p) => p.id === id); if (!project) throw new Error('No such project');
    const nextName = label(name, 'Project name');
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 30)) throw new Error('Aliases must be a list of at most 30 names');
    const nextAliases = aliases === undefined ? project.aliases : [...new Set(aliases.map((a) => label(a, 'Alias')))];
    project.name = nextName; project.aliases = nextAliases; this.save(); return structuredClone(project);
  }
  remove(id: string) {
    const project = this.entries.find((p) => p.id === id); if (!project) throw new Error('No such project');
    this.removed = [...new Set([...this.removed, project.path, project.canonicalPath, ...(project.registeredPaths ?? [])])];
    this.entries = this.entries.filter((p) => p.id !== id); this.save();
  }
  seed(rows: { cwd?: string | null; updated_at?: string | null; started_at?: string | null }[]) {
    let changed = false;
    for (const row of rows) {
      if (!row.cwd || !isAbsolute(row.cwd)) continue;
      try {
        const path = normalize(row.cwd), prior = this.forPath(path);
        if (!prior && notAProject(path, this.roots, this.isRegistered)) continue;
        const canonicalPath = readableDirectory(path, prior?.canonicalPath);
        if (this.removed.includes(path) || this.removed.includes(canonicalPath)) continue;
        let project = prior ?? this.entries.find((p) => p.canonicalPath === canonicalPath);
        if (!project) {
          if (this.entries.length >= 500) continue;
          project = { id: randomUUID(), name: basename(canonicalPath) || canonicalPath, path, canonicalPath, registeredPaths: [path], aliases: [], lastUsed: null };
          this.entries.push(project); changed = true;
        }
        // Every observed spelling is a registered path too; never repin on a later poll.
        this.validate(project);
        const paths = project.registeredPaths ?? [project.path];
        if (!paths.includes(path)) { project.registeredPaths = [...paths, path]; changed = true; }
        const date = row.updated_at || row.started_at;
        if (date && Number.isFinite(Date.parse(date))) {
          const at = new Date(date).toISOString();
          if (!project.lastUsed || project.lastUsed < at) { project.lastUsed = at; changed = true; }
        }
      } catch { /* Unavailable recent directories remain visible if already registered. */ }
    }
    if (changed) this.save();
  }
  /**
   * Drops entries seed() would not create, or whose directory is gone (#234). Pruned entries are
   * not added to `removed`, which records deliberate user removals. Returns what it dropped.
   */
  prune({ dryRun = false } = {}): Project[] {
    const dropped = this.entries.filter((p) => !existsSync(p.canonicalPath) || [p.path, p.canonicalPath].some((path) => notAProject(path, this.roots, this.isRegistered)));
    if (!dryRun && dropped.length) { this.entries = this.entries.filter((p) => !dropped.includes(p)); this.save(); }
    return structuredClone(dropped);
  }
  private validate(project: Project) {
    for (const path of project.registeredPaths ?? [project.path]) readableDirectory(path, project.canonicalPath);
    return project.canonicalPath;
  }
  resolve(reference: string): ProjectResolution {
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 4096) throw new Error('Choose a project name or absolute directory');
    reference = reference.trim();
    if (isAbsolute(reference)) {
      let project = this.forPath(normalize(reference));
      const path = readableDirectory(reference, project?.canonicalPath);
      project ??= this.forPath(path);
      if (project) this.validate(project);
      return { status: 'resolved', path, ...(project ? { project: structuredClone(project) } : {}) };
    }
    const query = key(reference), projects = this.list();
    const exact = projects.filter((p) => [p.name, ...p.aliases, ...[p.path, p.canonicalPath, ...(p.registeredPaths ?? [])].map((path) => basename(path))].some((v) => key(v) === query));
    const candidates = exact.length ? exact : projects.filter((p) => [p.name, ...p.aliases, p.path, p.canonicalPath, ...(p.registeredPaths ?? [])].some((v) => key(v).includes(query)));
    if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'not_found', candidates };
    const project = candidates[0];
    return { status: 'resolved', path: this.validate(project), project };
  }
  require(reference: string): Extract<ProjectResolution, { status: 'resolved' }> {
    const result = this.resolve(reference);
    if (result.status !== 'resolved') throw new Error(result.status === 'ambiguous' ? 'Several projects match. Choose a project by its absolute path.' : 'No project matches. Choose a registered project or enter an absolute directory.');
    return result;
  }
  used(path: string) {
    const project = this.forPath(path);
    if (project) { project.lastUsed = new Date().toISOString(); this.save(); }
  }
}
