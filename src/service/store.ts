// The rules store (#68, ContextProfileStore.ts): its own private file in the plugin's data folder, apart from any
// settings — rules.json, 0600 in a 0700 folder, written atomically, every change checked against the revision the page
// last read, so two editors never overwrite each other silently.
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { checkId, checkImports, checkRule, checkState, checkText, emptyState, type Category, type ImportSource, type Project, type Rule, type RulesState, type RuleValue, type Scope, type Task } from '../shared/rules.ts';
import { conventionProblem } from '../shared/presets.ts';
import { rootIdentity, within } from './importer.ts';

const MAX_BYTES = 8 * 1024 * 1024;

export interface RuleInput { id?: string; scope: Exclude<Scope, 'current'>; ownerId?: string; category: Category; key: string; value: RuleValue; enabled: boolean }

export class RulesStore {
  private readonly folder: string;
  private value?: RulesState;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) { this.folder = join(dataDir, 'rules'); }

  get(): RulesState {
    if (!this.value) {
      let raw: string | undefined;
      try {
        const info = lstatSync(join(this.folder, 'rules.json'));
        if (!info.isFile() || info.size > MAX_BYTES || info.mode & 0o077) throw new Error('The rules file is not a private file of at most 8 MB.');
        raw = readFileSync(join(this.folder, 'rules.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const value: unknown = raw === undefined ? emptyState() : JSON.parse(raw);
      checkState(value);
      this.value = value;
    }
    return structuredClone(this.value);
  }

  /** The registered project whose folder holds `cwd` (the innermost one). */
  projectFor(cwd: string): Project | undefined {
    let path: string;
    try { path = realpathSync(cwd); } catch { return undefined; }
    return this.get().projects.filter(p => within(p.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
  }

  private update(revision: number, change: (next: RulesState) => void): Promise<RulesState> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      const next = this.get();
      if (!Number.isSafeInteger(revision) || revision !== next.revision) throw new Error('The rules changed meanwhile; reload and try again.');
      change(next);
      next.revision++;
      checkState(next);
      const raw = JSON.stringify(next);
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      const temporary = join(this.folder, `${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, join(this.folder, 'rules.json')); } catch (error) { await rm(temporary, { force: true }); throw error; }
      this.value = next;
      return structuredClone(next);
    });
    this.writes = operation;
    return operation;
  }

  saveProject(input: { id?: string; label: string; root: string; organizationId?: string }, revision: number): Promise<RulesState> {
    return this.update(revision, state => {
      if (!input || Object.keys(input).some(key => !['id', 'label', 'root', 'organizationId'].includes(key))) throw new Error('Invalid project fields.');
      checkText(input.label, 160, 'project name');
      checkText(input.root, 4096, 'project folder');
      if (!isAbsolute(input.root)) throw new Error('Give the project folder as a full path, for example /Users/you/project.');
      let root: string;
      try { root = realpathSync(input.root); } catch { throw new Error('There is no such folder.'); }
      const identity = rootIdentity(root);
      const organizationId = input.organizationId?.trim() || undefined;
      if (organizationId !== undefined) checkId(organizationId, 'organization');
      const previous = input.id === undefined ? undefined : state.projects.find(p => p.id === input.id);
      if (input.id !== undefined && !previous) throw new Error('Unknown project.');
      if (state.projects.some(p => p.root === root && p.id !== input.id)) throw new Error('This folder is already a project.');
      const project: Project = { id: previous?.id ?? randomUUID(), label: input.label.trim(), root, rootIdentity: identity,
        ...(organizationId ? { organizationId } : {}), ...(previous?.root === root && previous.imports ? { imports: previous.imports } : {}) };
      state.projects = [...state.projects.filter(p => p.id !== project.id), project];
      // Organization rules live as long as some project names the organization.
      state.rules = state.rules.filter(r => r.scope !== 'organization' || state.projects.some(p => p.organizationId === r.ownerId));
    });
  }

  saveImports(projectId: string, imports: ImportSource[], revision: number): Promise<RulesState> {
    return this.update(revision, state => {
      checkId(projectId, 'project id');
      checkImports(imports);
      const project = state.projects.find(p => p.id === projectId);
      if (!project) throw new Error('Unknown project.');
      if (rootIdentity(project.root) !== project.rootIdentity) throw new Error(`The folder of ${project.label} was replaced; add the project again.`);
      project.imports = imports.map(entry => ({ path: entry.path, kind: entry.kind, ...(entry.selectors ? { selectors: [...entry.selectors] } : {}) }));
    });
  }

  saveTask(input: { id?: string; label: string; projectId: string }, revision: number): Promise<RulesState> {
    return this.update(revision, state => {
      if (!input || Object.keys(input).some(key => !['id', 'label', 'projectId'].includes(key))) throw new Error('Invalid task fields.');
      checkText(input.label, 160, 'task name');
      checkId(input.projectId, 'project id');
      if (!state.projects.some(p => p.id === input.projectId) || input.id !== undefined && !state.tasks.some(t => t.id === input.id && t.projectId === input.projectId)) throw new Error('Unknown task or project.');
      const task: Task = { id: input.id ?? randomUUID(), label: input.label.trim(), projectId: input.projectId };
      state.tasks = [...state.tasks.filter(t => t.id !== task.id), task];
    });
  }

  saveRule(input: RuleInput, revision: number): Promise<RulesState> {
    return this.update(revision, state => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['id', 'scope', 'ownerId', 'category', 'key', 'value', 'enabled'].includes(key))) throw new Error('Invalid rule fields.');
      if (input.id !== undefined && !state.rules.some(r => r.id === input.id)) throw new Error('Unknown rule (imported rules are read-only; override them instead).');
      const rule: Rule = { id: input.id ?? randomUUID(), scope: input.scope, ...(input.ownerId ? { ownerId: input.ownerId } : {}), category: input.category,
        key: typeof input.key === 'string' ? input.key.trim() : input.key, value: structuredClone(input.value), enabled: input.enabled, source: 'explicit', updatedAt: Date.now() };
      if ((rule.scope as string) === 'current') throw new Error('A launch instruction is given in the launcher, not saved.');
      checkRule(rule);
      const problem = conventionProblem(rule.key, rule.value);
      if (problem) throw new Error(problem);
      state.rules = [...state.rules.filter(r => r.id !== rule.id), rule];
    });
  }

  remove(kind: 'project' | 'task' | 'rule', id: string, revision: number): Promise<RulesState> {
    return this.update(revision, state => {
      checkId(id);
      if (kind === 'rule') state.rules = state.rules.filter(r => r.id !== id);
      else if (kind === 'task') {
        state.tasks = state.tasks.filter(t => t.id !== id);
        state.rules = state.rules.filter(r => r.scope !== 'task' || r.ownerId !== id);
      } else if (kind === 'project') {
        state.projects = state.projects.filter(p => p.id !== id);
        state.tasks = state.tasks.filter(t => t.projectId !== id);
        state.rules = state.rules.filter(r => r.scope === 'project' ? r.ownerId !== id : r.scope === 'task' ? state.tasks.some(t => t.id === r.ownerId)
          : r.scope === 'organization' ? state.projects.some(p => p.organizationId === r.ownerId) : true);
      } else throw new Error('Invalid kind.');
    });
  }
}
