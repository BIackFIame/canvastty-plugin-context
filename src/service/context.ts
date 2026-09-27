import type { Host } from '../rpc.ts';
import { CATEGORIES, checkText, MAX_RULES, resolveRules, type Category, type ImportDiagnostic, type ImportSource, type Project, type Rule, type RulesState, type Task } from '../shared/rules.ts';
import { CONVENTION_PRESETS, TOKEN_PRESETS } from '../shared/presets.ts';
import { contributionFor, DELIVERY, isDeliveryCli, type Contribution, type DeliveryCli } from './delivery.ts';
import { discover, importProject, type Candidate } from './importer.ts';
import { RulesStore, type RuleInput } from './store.ts';

/**
 * The Context service: project rules for agents. The settings page edits the store; the launcher's "Send rules" asks
 * `canvastty.launch.prepare`, which resolves the rules for the card's folder now (imports are read fresh) and hands
 * them to the agent CLI; orchestrators ask `rules_for`.
 */

/** `canvastty.launch.prepare` as CanvasTTY ≥ core2/8 sends it. */
export interface LaunchContext {
  sessionId: string; provider: string; profile: string; role: string; cwd: string; restoring: boolean; resume: boolean;
  options: Record<string, unknown> | null; chosen?: boolean; environment?: { pluginId: string; kind: string } | null;
}
export interface Caller { id: string; provider: string; role: string; cwd: string; workingDirectory?: string }
export type LaunchAnswer = Contribution | { refuse: { reason: string } } | null;

interface Want { cwd?: string; projectId?: string; taskId?: string; category?: string; current?: string; cli: DeliveryCli }
export interface Resolution {
  project: Project | null; task: Task | null; text: string; included: Rule[]; omitted: number; size: number; budget: number;
  diagnostics: ImportDiagnostic[];
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const refuse = (reason: string): LaunchAnswer => ({ refuse: { reason: reason.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) } });
const NONE = 'none';

export class ContextService {
  readonly store: RulesStore;
  private readonly pluginId: string;

  constructor(options: { host?: Host; dataDir: string; pluginId?: string }) {
    this.store = new RulesStore(options.dataDir);
    this.pluginId = options.pluginId ?? 'canvastty-context';
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
    return this.store.saveProject(params.project as { label: string; root: string }, Number(params.revision));
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
  prepare(context: LaunchContext): LaunchAnswer {
    if (context.chosen === false) return null;
    const options = context.options ?? {};
    if (options.send === false) return null;
    if (!isDeliveryCli(context.provider)) return refuse(`${context.provider} cannot receive rules at launch; turn off Send rules for it.`);
    try {
      const result = this.resolve({ cli: context.provider, cwd: context.cwd,
        ...(typeof options.task === 'string' ? { taskId: options.task } : {}), ...(typeof options.category === 'string' ? { category: options.category } : {}),
        ...(typeof options.current === 'string' ? { current: options.current } : {}) });
      if (!result.text) return null;
      return contributionFor(context.provider, result.text);
    } catch (error) {
      return refuse(errorText(error));
    }
  }

  // ---- orchestrator tool ----

  tool(name: string, input: Record<string, unknown>, caller: Caller | undefined): { content: unknown; isError?: boolean } {
    if (name !== 'rules_for') return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
    const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    const folder = text(input.folder, 4096) ?? caller?.cwd;
    if (!folder || !folder.startsWith('/')) return { content: 'Give `folder` as a full path (or call from a card that has a folder).', isError: true };
    const provider = text(input.provider, 20) ?? 'claude';
    if (!isDeliveryCli(provider)) return { content: 'Rules reach claude, codex and grok at launch; give one of them as `provider`, or leave it out.', isError: true };
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
        howTo: `Rules apply in this order: the launch's own instruction, task, project, organization, user, defaults. To give a subagent these rules at launch, pass launchOptions to spawn_agent unchanged (provider claude, codex or grok; ${provider} gets them as ${DELIVERY[provider].how}).`
      } };
    } catch (error) {
      return { content: errorText(error), isError: true };
    }
  }
}
