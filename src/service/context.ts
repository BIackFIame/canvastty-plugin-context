import { randomUUID } from 'node:crypto';
import type { Host } from '../rpc.ts';
import { CATEGORIES, checkText, MAX_RULES, resolveRules, type Category, type ImportDiagnostic, type ImportSource, type Project, type Rule, type RulesState, type Task } from '../shared/rules.ts';
import { CONVENTION_PRESETS, TOKEN_PRESETS } from '../shared/presets.ts';
import { contributionFor, DELIVERY, isDeliveryCli, type Contribution, type DeliveryCli } from './delivery.ts';
import { discover, importProject, type Candidate } from './importer.ts';
import { RulesStore, type RuleInput } from './store.ts';
import { cleanMemoryText, ProjectMemoryStore, truncateUtf8, type MemoryRecord } from './memory.ts';

/**
 * The Context service: project rules for agents. The settings page edits the store; the launcher's "Send rules" asks
 * `canvastty.launch.prepare`, which resolves the rules for the card's folder now (imports are read fresh) and hands
 * them to the agent CLI; orchestrators ask `rules_for`.
 */

/** `canvastty.launch.prepare` as CanvasTTY ≥ core2/8 sends it. */
export interface LaunchContext {
  sessionId: string; provider: string; profile: string; role: string; cwd: string; restoring: boolean; resume: boolean;
  /** Host-authenticated original project root before an environment such as a worktree changes the execution cwd. */
  projectRoot?: string;
  options: Record<string, unknown> | null; chosen?: boolean; environment?: { pluginId: string; kind: string } | null;
}
export interface Caller { id: string; provider: string; role: string; cwd: string; projectRoot?: string; workingDirectory?: string }
export type LaunchAnswer = Contribution | { refuse: { reason: string } } | null;

interface Want { cwd?: string; projectId?: string; taskId?: string; category?: string; current?: string; cli: DeliveryCli }
export interface Resolution {
  project: Project | null; task: Task | null; text: string; included: Rule[]; omitted: number; size: number; budget: number;
  diagnostics: ImportDiagnostic[];
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const refuse = (reason: string): LaunchAnswer => ({ refuse: { reason: reason.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) } });
const NONE = 'none';
const MEMORY_POLICY_KEY = 'memory-policy';

function appendMemory(rules: string, summary: string, cli: DeliveryCli): string {
  const measure = DELIVERY[cli].measure;
  const characters = [...summary];
  let low = 0, high = characters.length, best = rules;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const piece = characters.slice(0, middle).join('');
    const candidate = [rules, piece].filter(Boolean).join('\n\n');
    if (measure(candidate) <= DELIVERY[cli].budget) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

/**
 * Environments known to pass the launch on unchanged (their manifest declares `keeps.launch`), so the rules file or
 * argument reaches the agent there. CanvasTTY Environments' servers and containers leave out launch files and local
 * paths (the rules file among them) and declare no `keeps.launch`; an environment of another plugin is not known here.
 */
const KEEPS_LAUNCH: ReadonlySet<string> = new Set(['canvastty-environments/worktree']);

/** The card's note where the rules cannot travel with the launch. */
export function notDeliveredBadge(kind: string): { text: string; tone: 'warn'; tooltip: string } {
  const where = kind === 'ssh-host' ? 'server' : /container/u.test(kind) ? 'container' : 'environment';
  return { text: 'Rules not delivered', tone: 'warn',
    tooltip: `Project rules are not delivered on this ${where}: it does not pass the launch's files and arguments on. Give the agent the text of rules_for in its prompt if it needs them.` };
}

/** Unsupported CLIs still start, but get an explicit card note and an orchestrator-tool fallback. */
export function unsupportedCliBadge(provider: string): { text: string; tone: 'warn'; tooltip: string } {
  const label = provider.replace(/[^A-Za-z0-9 -]/gu, '').slice(0, 24) || 'this CLI';
  return { text: 'Rules not delivered', tone: 'warn',
    tooltip: `Project rules and memory are not sent to ${label}: no safe per-run instruction channel is verified. Put rules_for or recall in its task if needed.` };
}

export class ContextService {
  readonly store: RulesStore;
  private readonly pluginId: string;
  private readonly host: Host | undefined;
  private readonly dataDir: string;
  private requireMemoryApproval = true;
  private readonly projectMemories = new Map<string, ProjectMemoryStore>();
  private readonly memoryWrites = new Map<string, Promise<unknown>>();

  constructor(options: { host?: Host; dataDir: string; pluginId?: string }) {
    this.store = new RulesStore(options.dataDir);
    this.dataDir = options.dataDir;
    this.host = options.host;
    this.pluginId = options.pluginId ?? 'canvastty-context';
  }

  async loadMemoryPolicy(): Promise<void> {
    if (!this.host) return;
    try {
      const saved = await this.host.callHost('storage.get', { key: MEMORY_POLICY_KEY });
      if (saved && typeof saved === 'object' && typeof (saved as { requireApproval?: unknown }).requireApproval === 'boolean') {
        this.requireMemoryApproval = (saved as { requireApproval: boolean }).requireApproval;
      }
    } catch { /* approval stays on when the setting cannot be read */ }
  }

  /** The rules that apply to a folder (or a registered project), read now, sized for one agent CLI. */
  resolve(want: Want): Resolution {
    const state = this.store.get();
    const project = want.projectId ? state.projects.find(p => p.id === want.projectId) : want.cwd ? this.store.projectFor(want.cwd) : undefined;
    if (want.projectId && !project) throw new Error('Unknown project.');
    let task: Task | null = null;
    if (want.taskId && want.taskId !== NONE) {
      task = state.tasks.find(t => t.id === want.taskId) ?? null;
      if (!task) throw new Error('The saved task chosen for this launch no longer exists; choose another one.');
      if (task.projectId !== project?.id) throw new Error(`The task "${task.label.slice(0, 60)}" belongs to another project than this folder.`);
    }
    const category = want.category && want.category !== 'all' ? want.category : undefined;
    if (category && !CATEGORIES.includes(category as Category)) throw new Error(`Unknown category ${category.slice(0, 40)}.`);
    const imported = importProject(project, state.projects, MAX_RULES - state.rules.length);
    const current: Rule[] = [];
    if (want.current?.trim()) {
      checkText(want.current, 4096, 'launch instruction');
      current.push({ id: 'current', scope: 'current', category: 'communication', key: 'launch.instruction', value: want.current.trim(), enabled: true, source: 'explicit', updatedAt: Date.now() });
    }
    const delivery = DELIVERY[want.cli];
    const resolved = resolveRules([...state.rules, ...imported.rules, ...current], {
      ...(project ? { projectId: project.id } : {}), ...(project?.organizationId ? { organizationId: project.organizationId } : {}),
      ...(task ? { taskId: task.id } : {}), ...(category ? { categories: [category as Category] } : {}),
      budget: delivery.budget, measure: delivery.measure
    });
    return { project: project ?? null, task, ...resolved, budget: delivery.budget, diagnostics: imported.diagnostics };
  }

  // ---- the settings page ----

  state(): { state: RulesState; categories: readonly string[]; presets: { conventions: typeof CONVENTION_PRESETS; tokens: typeof TOKEN_PRESETS } } {
    return { state: this.store.get(), categories: CATEGORIES, presets: { conventions: CONVENTION_PRESETS, tokens: TOKEN_PRESETS } };
  }

  /** A project's imported rules and file notes, read now (the page shows them read-only). */
  imported(projectId: unknown): { rules: Rule[]; diagnostics: ImportDiagnostic[] } | { error: string } {
    const state = this.store.get();
    const project = state.projects.find(p => p.id === projectId);
    if (!project) throw new Error('Unknown project.');
    try { return importProject(project, state.projects, MAX_RULES - state.rules.length); } catch (error) { return { error: errorText(error) }; }
  }

  discover(projectId: unknown): Candidate[] {
    const project = this.store.get().projects.find(p => p.id === projectId);
    if (!project) throw new Error('Unknown project.');
    return discover(project);
  }

  preview(params: Record<string, unknown>): Omit<Resolution, 'included'> & { included: Array<Pick<Rule, 'scope' | 'category' | 'key' | 'source'>> } {
    const cli = isDeliveryCli(params.provider) ? params.provider : 'claude';
    const result = this.resolve({ cli, ...(typeof params.projectId === 'string' && params.projectId ? { projectId: params.projectId } : {}),
      ...(typeof params.taskId === 'string' ? { taskId: params.taskId } : {}), ...(typeof params.category === 'string' ? { category: params.category } : {}) });
    return { ...result, included: result.included.map(rule => ({ scope: rule.scope, category: rule.category, key: rule.key, source: rule.source })) };
  }

  saveProject(params: Record<string, unknown>): Promise<RulesState> {
    const input = params.project as { id?: string; label: string; root: string };
    const before = input?.id ? this.store.get().projects.find(project => project.id === input.id) : undefined;
    return this.store.saveProject(input, Number(params.revision)).then(state => {
      const after = input.id ? state.projects.find(project => project.id === input.id) : undefined;
      if (before && after && before.root !== after.root) this.projectMemories.delete(before.id);
      return state;
    });
  }
  saveImports(params: Record<string, unknown>): Promise<RulesState> {
    return this.store.saveImports(String(params.projectId), params.imports as ImportSource[], Number(params.revision));
  }
  saveTask(params: Record<string, unknown>): Promise<RulesState> {
    return this.store.saveTask(params.task as { label: string; projectId: string }, Number(params.revision));
  }
  saveRule(params: Record<string, unknown>): Promise<RulesState> {
    return this.store.saveRule(params.rule as RuleInput, Number(params.revision));
  }
  remove(params: Record<string, unknown>): Promise<RulesState> {
    return this.store.remove(params.kind as 'project' | 'task' | 'rule', String(params.id), Number(params.revision));
  }

  // ---- CanvasTTY: the launcher list and the launch ----

  /** `canvastty.launch.options`: the saved tasks, named with their project (the launcher does not say the folder yet). */
  launchOptions(): Record<string, Array<{ value: string; label: string }>> {
    const state = this.store.get();
    const label = (task: Task): string => `${state.projects.find(p => p.id === task.projectId)?.label ?? '?'} · ${task.label}`.slice(0, 120);
    return { task: state.tasks.slice(0, 64).map(task => ({ value: task.id, label: label(task) })) };
  }

  /** `canvastty.launch.prepare`: "Send rules" on → the rules for the card's folder, delivered the CLI's way. */
  async prepare(context: LaunchContext): Promise<LaunchAnswer> {
    if (context.chosen === false) return null;
    const options = context.options ?? {};
    if (options.send === false) return null;
    if (!isDeliveryCli(context.provider)) {
      void this.host?.callHost('cards.setBadge', { sessionId: context.sessionId, badge: unsupportedCliBadge(context.provider) }).catch(() => undefined);
      return null;
    }
    // The card starts without the rules (never blocked), and says so instead of dropping them silently.
    if (context.environment && !KEEPS_LAUNCH.has(`${context.environment.pluginId}/${context.environment.kind}`)) {
      void this.host?.callHost('cards.setBadge', { sessionId: context.sessionId, badge: notDeliveredBadge(context.environment.kind) }).catch(() => undefined);
      return null;
    }
    try {
      const projectRoot = context.projectRoot ?? context.cwd;
      const result = this.resolve({ cli: context.provider, cwd: projectRoot,
        ...(typeof options.task === 'string' ? { taskId: options.task } : {}), ...(typeof options.category === 'string' ? { category: options.category } : {}),
        ...(typeof options.current === 'string' ? { current: options.current } : {}) });
      const memory = await this.memorySummary(projectRoot);
      const combined = memory ? appendMemory(result.text, memory, context.provider) : result.text;
      if (!combined) return null;
      return contributionFor(context.provider, combined);
    } catch (error) {
      return refuse(errorText(error));
    }
  }

  // ---- orchestrator tool ----

  async memoryState(projectId: unknown): Promise<{ project: Pick<Project, 'id' | 'label' | 'root'>; records: MemoryRecord[]; requireApproval: boolean }> {
    const project = this.project(projectId);
    return { project: { id: project.id, label: project.label, root: project.root }, records: await this.memoryStore(project).read(), requireApproval: this.requireMemoryApproval };
  }

  async saveMemory(params: Record<string, unknown>): Promise<{ records: MemoryRecord[] }> {
    const project = this.project(params.projectId);
    return this.serialMemory(project.id, async () => {
      const memory = this.memoryStore(project);
      const records = await memory.read();
      const id = typeof params.id === 'string' ? params.id : undefined;
      const existing = id ? records.find(record => record.id === id) : undefined;
      if (id && !existing) throw new Error('Unknown memory item.');
      const text = await this.maskMemory(cleanMemoryText(params.text));
      const record: MemoryRecord = { id: existing?.id ?? randomUUID(), text, author: 'person', createdAt: Date.now(), approved: true };
      await memory.save([...records.filter(item => item.id !== record.id), record]);
      return { records: await memory.read() };
    });
  }

  async approveMemory(params: Record<string, unknown>): Promise<{ records: MemoryRecord[] }> {
    const project = this.project(params.projectId);
    return this.serialMemory(project.id, async () => {
      const memory = this.memoryStore(project);
      const records = await memory.read();
      const record = records.find(item => item.id === params.id);
      if (!record) throw new Error('Unknown memory item.');
      record.text = await this.maskMemory(record.text);
      record.approved = true;
      await memory.save(records);
      return { records: await memory.read() };
    });
  }

  async removeMemory(params: Record<string, unknown>): Promise<{ records: MemoryRecord[] }> {
    const project = this.project(params.projectId);
    return this.serialMemory(project.id, async () => {
      const memory = this.memoryStore(project);
      const records = await memory.read();
      await memory.save(records.filter(item => item.id !== params.id));
      return { records: await memory.read() };
    });
  }

  async setMemoryPolicy(params: Record<string, unknown>): Promise<{ requireApproval: boolean }> {
    if (typeof params.requireApproval !== 'boolean') throw new Error('requireApproval must be true or false.');
    if (!this.host) throw new Error('Plugin storage is unavailable.');
    await this.host.callHost('storage.set', { key: MEMORY_POLICY_KEY, value: { requireApproval: params.requireApproval } });
    this.requireMemoryApproval = params.requireApproval;
    return { requireApproval: this.requireMemoryApproval };
  }

  private project(id: unknown): Project {
    const project = this.store.get().projects.find(item => item.id === id);
    if (!project) throw new Error('Choose a registered project. Project memory never writes outside a registered project.');
    return project;
  }

  private memoryStore(project: Project): ProjectMemoryStore {
    let memory = this.projectMemories.get(project.id);
    if (!memory) { memory = new ProjectMemoryStore(project, this.dataDir); this.projectMemories.set(project.id, memory); }
    return memory;
  }

  private serialMemory<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.memoryWrites.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    this.memoryWrites.set(projectId, operation);
    return operation.finally(() => { if (this.memoryWrites.get(projectId) === operation) this.memoryWrites.delete(projectId); });
  }

  private async maskMemory(text: string): Promise<string> {
    if (!this.host) throw new Error('Secret masking is unavailable; memory was not saved.');
    const result = await this.host.callHost('redaction.mask', { text }) as { text?: unknown };
    if (!result || typeof result.text !== 'string') throw new Error('Secret masking is unavailable; memory was not saved.');
    return cleanMemoryText(result.text);
  }

  private async memorySummary(cwd: string): Promise<string> {
    if (!this.host) return '';
    const project = this.store.projectFor(cwd);
    if (!project) return '';
    let records: MemoryRecord[];
    try { records = await this.memoryStore(project).read(); } catch { return ''; }
    const approved = records.filter(record => record.approved).slice(-20);
    if (!approved.length) return '';
    const raw = `Approved project memory:\n${approved.map(record => `- ${record.text} — ${record.author}, ${new Date(record.createdAt).toISOString().slice(0, 10)}`).join('\n')}`;
    let masked: string;
    try {
      const result = await this.host.callHost('redaction.mask', { text: raw }) as { text?: unknown };
      if (!result || typeof result.text !== 'string') return '';
      masked = result.text;
    } catch { return ''; }
    return truncateUtf8(masked, 4_096);
  }

  private async remember(input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {
    const cwd = caller?.projectRoot ?? caller?.cwd ?? caller?.workingDirectory;
    const project = cwd ? this.store.projectFor(cwd) : undefined;
    if (!project) return { content: 'No registered project contains this card; project memory was not changed.', isError: true };
    return this.serialMemory(project.id, async () => {
      const memory = this.memoryStore(project);
      const records = await memory.read();
      if (records.length >= 200) return { content: 'This project has 200 memory entries; remove an old one in Context settings first.', isError: true };
      const text = await this.maskMemory(cleanMemoryText(input.text));
      const record: MemoryRecord = { id: randomUUID(), text, author: `${(caller?.provider ?? 'agent').slice(0, 40)} agent`, createdAt: Date.now(), approved: !this.requireMemoryApproval };
      await memory.save([...records, record]);
      return { content: record.approved ? 'Saved as approved project memory.' : 'Saved as pending project memory; a person must approve it in Context settings before agents receive it.' };
    });
  }

  private async recall(input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {
    const cwd = caller?.projectRoot ?? caller?.cwd ?? caller?.workingDirectory;
    const project = cwd ? this.store.projectFor(cwd) : undefined;
    if (!project) return { content: 'No registered project contains this card; no project memory is available.', isError: true };
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 200).toLocaleLowerCase() : '';
    const records = (await this.memoryStore(project).read()).filter(record => record.approved);
    const matches = records.filter(record => !query || record.text.toLocaleLowerCase().includes(query)).slice(-8);
    return { content: matches.length ? matches.map(record => ({ text: record.text, author: record.author, date: new Date(record.createdAt).toISOString(), approved: true })) : 'No approved project memory matches that query.' };
  }

  private async memoryTool(name: string, input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {
    try { return name === 'remember' ? await this.remember(input, caller) : await this.recall(input, caller); }
    catch (error) { return { content: errorText(error), isError: true }; }
  }

  async tool(name: string, input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {
    if (name === 'remember' || name === 'recall') return this.memoryTool(name, input, caller);
    if (name !== 'rules_for') return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
    const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    const folder = text(input.folder, 4096) ?? caller?.cwd;
    if (!folder || !folder.startsWith('/')) return { content: 'Give `folder` as a full path (or call from a card that has a folder).', isError: true };
    const provider = text(input.provider, 20) ?? 'claude';
    if (!isDeliveryCli(provider)) return { content: 'Rules reach claude, codex, grok, qwen and pi at launch; give one of them as `provider`, or leave it out.', isError: true };
    const state = this.store.get();
    const project = this.store.projectFor(folder);
    const taskName = text(input.task, 160);
    let taskId: string | undefined;
    if (taskName) {
      const task = state.tasks.find(t => t.projectId === project?.id && (t.id === taskName || t.label.toLowerCase() === taskName.toLowerCase()));
      if (!task) {
        const known = state.tasks.filter(t => t.projectId === project?.id).map(t => t.label);
        return { content: `No saved task "${taskName}" in ${project ? `project ${project.label}` : 'this folder (it is in no registered project)'}.${known.length ? ` Tasks: ${known.join(', ')}.` : ''}`, isError: true };
      }
      taskId = task.id;
    }
    const category = text(input.category, 40);
    try {
      const result = this.resolve({ cli: provider, cwd: folder, ...(taskId ? { taskId } : {}), ...(category ? { category } : {}) });
      return { content: {
        folder, project: result.project ? { name: result.project.label, folder: result.project.root, organization: result.project.organizationId ?? null } : null,
        task: result.task?.label ?? null,
        rules: result.included.map(rule => ({ scope: rule.scope, category: rule.category, key: rule.key, value: rule.value, source: rule.source })),
        omitted: result.omitted, text: result.text, notes: result.diagnostics.map(d => `${d.sourcePath}: ${d.message}`),
        launchOptions: { [this.pluginId]: { send: true, task: taskId ?? NONE, category: category ?? 'all', current: '' } },
        howTo: `Rules apply in this order: the launch's own instruction, task, project, organization, user, defaults. To give a subagent these rules at launch, pass launchOptions to spawn_agent unchanged (provider claude, codex, grok, qwen or pi; ${provider} gets them as ${DELIVERY[provider].how}). They reach an agent on this computer or in a worktree; on a server or in a container the agent starts without them, so put the text in the prompt instead.`
      } };
    } catch (error) {
      return { content: errorText(error), isError: true };
    }
  }
}
