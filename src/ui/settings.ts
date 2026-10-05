// The Project rules settings page (bundled to settings/context.js). It runs in CanvasTTY's sandboxed plugin frame (no
// forms: buttons only) and only talks to the plugin's own service, which validates and stores everything.
import { MAX_IMPORTS, type Category, type ImportDiagnostic, type ImportKind, type Project, type Rule, type RulesState, type RuleValue, type Scope, type Task } from '../shared/rules.ts';
import type { Preset } from '../shared/presets.ts';

interface PluginHost {
  onContext(listener: (context: { appearance: { locale: string } }) => void): void;
  service: { request(serviceId: string, method: string, params?: unknown): Promise<unknown> };
}
interface Candidate { path: string; kind: ImportKind; selected: boolean }
interface Preview { text: string; omitted: number; size: number; budget: number; included: Array<{ key: string }>; diagnostics: ImportDiagnostic[] }
interface Draft { id?: string; scope: Exclude<Scope, 'current'>; taskId?: string; category: Category; key: string; valueText: string; json: boolean; enabled: boolean }
interface MemoryEntry { id: string; text: string; author: string; createdAt: number; approved: boolean }
interface MemoryState { project: { id: string; label: string; root: string }; records: MemoryEntry[]; requireApproval: boolean }

const host = (window as unknown as { CanvasTTYPlugin: PluginHost }).CanvasTTYPlugin;
const SERVICE = 'context';
const GLOBAL = '';

const STRINGS = {
  en: {
    title: 'Project rules',
    lead: 'Rules agents get when you launch them with "Send rules" (launcher → Advanced → Use CanvasTTY Context). Priority: the launch\'s own instruction → task → project → organization → user → defaults; a more specific rule with the same key wins. Claude Code gets them as an appended system prompt file; Codex as developer instructions; Grok as --rules; Qwen Code and Pi as per-run --append-system-prompt text.',
    projects: 'Projects', everyone: 'Everyone (user and default rules)', addProject: 'Add project', folder: 'Folder (full path)', name: 'Name', organization: 'Organization (optional id)',
    remove: 'Remove', open: 'Open', rulesFor: (name: string) => `Rules · ${name}`, search: 'Search', allCategories: 'All categories', none: 'No rules here yet.',
    scope: 'Scope', task: 'Task', category: 'Category', key: 'Key (optional, e.g. reply.language)', value: 'Rule', json: 'Value is JSON', enabled: 'On',
    addRule: 'Add rule', editRule: 'Edit rule', saveRule: 'Save rule', cancel: 'Cancel', edit: 'Edit', override: 'Override', imported: 'imported', off: 'off',
    tokens: 'Design tokens', conventions: 'Checkable conventions (JSON presets)', conventionsHint: 'validate.* rules use a narrow JSON vocabulary; edit the preset values before saving.',
    tasks: 'Tasks', taskName: 'Task name', addTask: 'Add task', noTasks: 'No tasks.',
    importTitle: 'Import from project files', importHint: 'Reads the files you select whenever rules are needed (no background scan): AGENTS.md, CLAUDE.md, GEMINI.md, CONTRIBUTING.md, .cursorrules, .windsurfrules, Cursor rules, README development sections, .editorconfig, Prettier/ESLint JSON, CSS custom properties. JavaScript configs are never run.',
    findFiles: 'Find project files', saveImports: 'Save selection', noFiles: 'No convention files found in this folder.',
    previewTitle: 'What an agent gets', preview: 'Show', previewEmpty: 'Nothing: no rule applies here.', previewSize: (size: number, budget: number, omitted: number) => `${size} of ${budget}${omitted ? `; ${omitted} rule(s) left out for space` : ''}`,
    saved: 'Saved.', notSaved: 'Not saved: ', removed: 'Removed.', tooManyImports: (max: number) => `At most ${max} project files can be imported.`,
    memory: 'Project memory', memoryHelp: 'Approved notes are added to launch instructions in a summary of at most 4 KiB. Memory is kept privately in CanvasTTY plugin data outside the project; existing project-file notes are imported as pending proposals and need approval again.',
    remember: 'Remember a durable fact', memoryPlaceholder: 'A project convention, decision, or fact that will matter in future tasks', saveMemory: 'Save approved memory', approveMemory: 'Approve', pendingMemory: 'Pending approval', approvedMemory: 'Approved',
    requireApproval: 'Agent memories need approval before use', noMemory: 'No memory entries yet.', memoryHuman: 'Person',
    scopes: { defaults: 'Defaults', user: 'You (all projects)', organization: 'Organization', project: 'This project', task: 'Task' } as Record<string, string>
  },
  ru: {
    title: 'Правила проектов',
    lead: 'Правила, которые агенты получают при запуске с «Send rules» (окно запуска → Дополнительно → Use CanvasTTY Context). Приоритет: инструкция самого запуска → задача → проект → организация → пользователь → значения по умолчанию; более конкретное правило с тем же ключом сильнее. Claude Code получает их файлом, добавленным к системному промпту; Codex — как developer instructions; Grok — через --rules; Qwen Code и Pi — как текст --append-system-prompt для одного запуска.',
    projects: 'Проекты', everyone: 'Для всех (правила пользователя и по умолчанию)', addProject: 'Добавить проект', folder: 'Папка (полный путь)', name: 'Название', organization: 'Организация (id, необязательно)',
    remove: 'Удалить', open: 'Открыть', rulesFor: (name: string) => `Правила · ${name}`, search: 'Поиск', allCategories: 'Все категории', none: 'Здесь пока нет правил.',
    scope: 'Область', task: 'Задача', category: 'Категория', key: 'Ключ (необязательно, напр. reply.language)', value: 'Правило', json: 'Значение — JSON', enabled: 'Вкл.',
    addRule: 'Добавить правило', editRule: 'Изменить правило', saveRule: 'Сохранить правило', cancel: 'Отмена', edit: 'Изменить', override: 'Переопределить', imported: 'импорт', off: 'выкл.',
    tokens: 'Токены дизайна', conventions: 'Проверяемые соглашения (шаблоны JSON)', conventionsHint: 'Ключи validate.* используют узкий формат JSON; отредактируйте значения шаблона перед сохранением.',
    tasks: 'Задачи', taskName: 'Название задачи', addTask: 'Добавить задачу', noTasks: 'Задач нет.',
    importTitle: 'Импорт из файлов проекта', importHint: 'Выбранные файлы читаются каждый раз, когда нужны правила (без фонового сканирования): AGENTS.md, CLAUDE.md, GEMINI.md, CONTRIBUTING.md, .cursorrules, .windsurfrules, правила Cursor, разделы README о разработке, .editorconfig, JSON Prettier/ESLint, CSS-переменные. JavaScript-конфиги не запускаются.',
    findFiles: 'Найти файлы проекта', saveImports: 'Сохранить выбор', noFiles: 'В этой папке нет файлов с соглашениями.',
    previewTitle: 'Что получит агент', preview: 'Показать', previewEmpty: 'Ничего: здесь не действует ни одно правило.', previewSize: (size: number, budget: number, omitted: number) => `${size} из ${budget}${omitted ? `; не поместилось правил: ${omitted}` : ''}`,
    saved: 'Сохранено.', notSaved: 'Не сохранено: ', removed: 'Удалено.', tooManyImports: (max: number) => `Импортировать можно не больше ${max} файлов проекта.`,
    memory: 'Память проекта', memoryHelp: 'Одобренные заметки добавляются к инструкциям запуска в кратком обзоре размером до 4 КиБ. Память хранится отдельно в закрытых данных плагина CanvasTTY; прежние заметки из файла проекта импортируются как ожидающие одобрения и требуют повторного одобрения.',
    remember: 'Запомнить важный факт', memoryPlaceholder: 'Соглашение, решение или факт проекта для будущих задач', saveMemory: 'Сохранить одобренное', approveMemory: 'Одобрить', pendingMemory: 'Ожидает одобрения', approvedMemory: 'Одобрено',
    requireApproval: 'Память агентов требует одобрения', noMemory: 'Пока нет записей.', memoryHuman: 'Вы',
    scopes: { defaults: 'По умолчанию', user: 'Вы (все проекты)', organization: 'Организация', project: 'Этот проект', task: 'Задача' } as Record<string, string>
  }
};
const CATEGORY_RU: Record<string, string> = {
  design: 'дизайн', architecture: 'архитектура', 'code-style': 'стиль кода', security: 'безопасность', testing: 'тесты', deployment: 'развёртывание',
  documentation: 'документация', 'business-rules': 'бизнес-правила', naming: 'имена', dependencies: 'зависимости', communication: 'общение'
};

let locale: 'en' | 'ru' = 'en';
let t = STRINGS.en;
let data: { state: RulesState; categories: Category[]; presets: { conventions: Preset[]; tokens: Preset[] } } | null = null;
let selected = GLOBAL;
let search = '';
let filter = '';
let draft: Draft | null = null;
let importedRules: Rule[] = [];
let importNotes: ImportDiagnostic[] = [];
let importError = '';
let candidates: Candidate[] | null = null;
/** The project the shown candidates were found in (saving them goes there, whatever is selected by then). */
let candidatesFor = '';
let memoryData: MemoryState | null = null;
/** Bumped whenever another project is selected: an answer for the one before is dropped. */
let view = 0;
let preview: Preview | null = null;
let previewCli = 'claude';

const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string): void => { status.textContent = message; };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const request = (method: string, params?: unknown): Promise<unknown> => host.service.request(SERVICE, method, params);
const categoryLabel = (category: string): string => locale === 'ru' ? CATEGORY_RU[category] ?? category : category;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}
const button = (label: string, name: string, onClick: () => void): HTMLButtonElement => {
  const node = el('button', { type: 'button', textContent: label, name });
  node.addEventListener('click', onClick);
  return node;
};
const field = (label: string, control: HTMLElement): HTMLLabelElement => el('label', { className: 'field' }, el('span', { textContent: label }), control);
const select = (name: string, options: Array<[string, string]>, value: string, onChange?: (value: string) => void): HTMLSelectElement => {
  const node = el('select', { name });
  for (const [optionValue, label] of options) node.append(el('option', { value: optionValue, textContent: label }));
  node.value = value;
  if (onChange) node.addEventListener('change', () => onChange(node.value));
  return node;
};

const project = (): Project | undefined => data?.state.projects.find(p => p.id === selected);
const projectTasks = (): Task[] => data?.state.tasks.filter(task => task.projectId === selected) ?? [];

async function load(): Promise<void> {
  data = await request('state') as typeof data;
  if (selected && !project()) { selected = GLOBAL; view++; candidates = null; preview = null; }
  await loadImported();
  await loadMemory();
  render();
}
async function loadMemory(): Promise<void> {
  memoryData = null;
  if (!selected) return;
  const asked = { projectId: selected, view };
  try {
    const answer = await request('memoryState', { projectId: asked.projectId }) as MemoryState;
    if (asked.view === view && asked.projectId === selected) memoryData = answer;
  } catch (error) { say(errorText(error)); }
}
async function loadImported(): Promise<void> {
  importedRules = []; importNotes = []; importError = '';
  if (!selected) return;
  const asked = { projectId: selected, view };
  const answer = await request('imported', { projectId: asked.projectId }) as { rules: Rule[]; diagnostics: ImportDiagnostic[] } | { error: string };
  if (asked.view !== view || asked.projectId !== selected) return;
  if ('error' in answer) importError = answer.error;
  else { importedRules = answer.rules; importNotes = answer.diagnostics; }
}

/** Shows another project (or everyone's rules) and forgets what was on screen for the one before. */
function choose(id: string): void {
  selected = id; view++; draft = null; candidates = null; preview = null;
  void load();
}

async function changeMemory(method: string, params: Record<string, unknown>): Promise<void> {
  try { await request(method, params); say(t.saved); await load(); }
  catch (error) { say(`${t.notSaved}${errorText(error)}`); }
}

/** Runs a store change with the revision the page shows; a stale page reloads instead of overwriting. The new state, or null. */
async function change(method: string, params: Record<string, unknown>, done = t.saved): Promise<RulesState | null> {
  if (!data) return null;
  try {
    const next = await request(method, { ...params, revision: data.state.revision }) as RulesState;
    say(done);
    await load();
    return next;
  } catch (error) {
    say(`${t.notSaved}${errorText(error)}`);
    return null;
  }
}

function visibleRules(): Rule[] {
  if (!data) return [];
  const p = project();
  const tasks = new Set(projectTasks().map(task => task.id));
  const own = data.state.rules.filter(rule => rule.scope === 'defaults' || rule.scope === 'user'
    || p && (rule.scope === 'project' && rule.ownerId === p.id || rule.scope === 'organization' && rule.ownerId === p.organizationId || rule.scope === 'task' && tasks.has(rule.ownerId!)));
  const needle = search.trim().toLocaleLowerCase();
  return [...own, ...importedRules].filter(rule => (!filter || rule.category === filter)
    && (!needle || `${rule.key} ${typeof rule.value === 'string' ? rule.value : JSON.stringify(rule.value)}`.toLocaleLowerCase().includes(needle)));
}

const valueText = (value: RuleValue): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const slug = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яё]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'rule';

function ruleItem(rule: Rule): HTMLLIElement {
  const item = el('li', { className: `rule${rule.enabled ? '' : ' rule--off'}`, dataset: { rule: rule.id, key: rule.key } });
  const task = rule.scope === 'task' ? data!.state.tasks.find(entry => entry.id === rule.ownerId)?.label : undefined;
  const where = `${t.scopes[rule.scope] ?? rule.scope}${task ? `: ${task}` : ''}`;
  const origin = rule.source === 'imported' && rule.provenance ? ` · ${t.imported} ${rule.provenance.sourcePath}:${rule.provenance.sourceLine}` : '';
  item.append(
    el('div', { className: 'rule__head' }, el('strong', { textContent: rule.key }), el('span', { className: 'muted', textContent: ` ${where} · ${categoryLabel(rule.category)}${origin}${rule.enabled ? '' : ` · ${t.off}`}` })),
    el('pre', { className: 'rule__value', textContent: valueText(rule.value).slice(0, 600) })
  );
  const actions = el('div', { className: 'row' });
  if (rule.source === 'imported') {
    actions.append(button(t.override, `override-${rule.id}`, () => {
      draft = { scope: 'project', category: rule.category, key: rule.key, valueText: valueText(rule.value), json: typeof rule.value !== 'string', enabled: true };
      render();
    }));
  } else {
    actions.append(
      button(t.edit, `edit-${rule.id}`, () => {
        draft = { id: rule.id, scope: rule.scope as Draft['scope'], ...(rule.scope === 'task' ? { taskId: rule.ownerId! } : {}), category: rule.category, key: rule.key,
          valueText: valueText(rule.value), json: typeof rule.value !== 'string', enabled: rule.enabled };
        render();
      }),
      button(t.remove, `remove-${rule.id}`, () => void change('remove', { kind: 'rule', id: rule.id }, t.removed))
    );
  }
  item.append(actions);
  return item;
}

function scopeOptions(): Array<[string, string]> {
  const p = project();
  const options: Array<[string, string]> = [];
  if (p) options.push(['project', t.scopes.project!]);
  if (p && projectTasks().length) options.push(['task', t.scopes.task!]);
  if (p?.organizationId) options.push(['organization', `${t.scopes.organization} ${p.organizationId}`]);
  options.push(['user', t.scopes.user!], ['defaults', t.scopes.defaults!]);
  return options;
}

function ruleForm(): HTMLElement {
  const p = project();
  const current: Draft = draft ?? { scope: p ? 'project' : 'user', category: 'communication', key: '', valueText: '', json: false, enabled: true };
  const box = el('div', { className: 'rule-form' });
  const scope = select('rule-scope', scopeOptions(), current.scope);
  const tasks = projectTasks();
  const task = select('rule-task', tasks.map(entry => [entry.id, entry.label]), current.taskId ?? tasks[0]?.id ?? '');
  const taskField = field(t.task, task);
  taskField.hidden = scope.value !== 'task';
  scope.addEventListener('change', () => { taskField.hidden = scope.value !== 'task'; });
  const category = select('rule-category', data!.categories.map(entry => [entry, categoryLabel(entry)]), current.category);
  const key = el('input', { name: 'rule-key', value: current.key, placeholder: 'reply.language', maxLength: 160 });
  const value = el('textarea', { name: 'rule-value', value: current.valueText, rows: 4 });
  const json = el('input', { type: 'checkbox', name: 'rule-json', checked: current.json });
  const enabled = el('input', { type: 'checkbox', name: 'rule-enabled', checked: current.enabled });
  const usePreset = (preset: Preset): void => {
    draft = { ...(draft?.id ? { id: draft.id } : {}), scope: p ? 'project' : 'user', category: preset.category, key: preset.key, valueText: valueText(preset.value), json: typeof preset.value !== 'string', enabled: true };
    render();
  };
  box.append(
    el('h3', { textContent: current.id ? t.editRule : t.addRule }),
    el('div', { className: 'row' }, field(t.scope, scope), taskField, field(t.category, category), field(t.key, key)),
    field(t.value, value),
    el('div', { className: 'row' }, el('label', { className: 'check' }, json, ` ${t.json}`), el('label', { className: 'check' }, enabled, ` ${t.enabled}`)),
    el('div', { className: 'row' },
      button(t.saveRule, 'save-rule', () => {
        let parsed: RuleValue = value.value;
        if (json.checked) { try { parsed = JSON.parse(value.value) as RuleValue; } catch (error) { say(`${t.notSaved}${errorText(error)}`); return; } }
        const chosenScope = scope.value as Draft['scope'];
        const ownerId = chosenScope === 'project' ? p?.id : chosenScope === 'organization' ? p?.organizationId : chosenScope === 'task' ? task.value : undefined;
        const ruleKey = key.value.trim() || `rule.${slug(typeof parsed === 'string' ? parsed.split(/\s+/u).slice(0, 5).join(' ') : category.value)}`;
        void change('saveRule', { rule: { ...(current.id ? { id: current.id } : {}), scope: chosenScope, ...(ownerId ? { ownerId } : {}), category: category.value, key: ruleKey, value: parsed, enabled: enabled.checked } })
          .then(ok => { if (ok) { draft = null; render(); } });
      }),
      button(t.cancel, 'cancel-rule', () => { draft = null; render(); })),
    el('details', {}, el('summary', { textContent: t.tokens }), el('div', { className: 'row' }, ...data!.presets.tokens.map(preset => button(locale === 'ru' ? preset.ru : preset.en, `preset-${preset.id}`, () => usePreset(preset))))),
    el('details', {}, el('summary', { textContent: t.conventions }), el('p', { className: 'muted', textContent: t.conventionsHint }),
      el('div', { className: 'row' }, ...data!.presets.conventions.map(preset => button(locale === 'ru' ? preset.ru : preset.en, `preset-${preset.id}`, () => usePreset(preset)))))
  );
  return box;
}

function projectsSection(): HTMLElement {
  const list = el('ul', { className: 'projects' });
  const entry = (id: string, label: string, detail: string, removable: boolean): HTMLLIElement => {
    const item = el('li', { className: `project${selected === id ? ' project--selected' : ''}`, dataset: { project: id || 'global' } });
    item.append(button(label, `open-${id || 'global'}`, () => choose(id)),
      el('span', { className: 'muted', textContent: detail }));
    if (removable) item.append(button(t.remove, `remove-project-${id}`, () => void change('remove', { kind: 'project', id }, t.removed)));
    return item;
  };
  list.append(entry(GLOBAL, t.everyone, '', false));
  for (const p of data!.state.projects) list.append(entry(p.id, p.label, ` ${p.root}${p.organizationId ? ` · ${p.organizationId}` : ''}`, true));
  const folder = el('input', { name: 'project-root', placeholder: '/Users/you/project' });
  const name = el('input', { name: 'project-label' });
  const organization = el('input', { name: 'project-org' });
  return el('section', {}, el('h2', { textContent: t.projects }), list,
    el('div', { className: 'row add' }, field(t.folder, folder), field(t.name, name), field(t.organization, organization),
      button(t.addProject, 'add-project', () => {
        const root = folder.value.trim();
        const label = name.value.trim() || root.split('/').filter(Boolean).pop() || root;
        const before = new Set(data?.state.projects.map(p => p.id));
        void change('saveProject', { project: { label, root, ...(organization.value.trim() ? { organizationId: organization.value.trim() } : {}) } }).then(next => {
          // The project this save added, by id: another one may carry the same name.
          const added = next?.projects.find(p => !before.has(p.id));
          if (added && data?.state.projects.some(p => p.id === added.id)) { choose(added.id); render(); }
        });
      })));
}

function tasksSection(): HTMLElement {
  const list = el('ul', { className: 'tasks' });
  const tasks = projectTasks();
  if (!tasks.length) list.append(el('li', { className: 'muted', textContent: t.noTasks }));
  for (const task of tasks) list.append(el('li', { dataset: { task: task.id } }, `${task.label} `, button(t.remove, `remove-task-${task.id}`, () => void change('remove', { kind: 'task', id: task.id }, t.removed))));
  const label = el('input', { name: 'task-label' });
  return el('section', {}, el('h3', { textContent: t.tasks }), list,
    el('div', { className: 'row' }, field(t.taskName, label), button(t.addTask, 'add-task', () => { if (label.value.trim()) void change('saveTask', { task: { label: label.value.trim(), projectId: selected } }); })));
}

function importSection(): HTMLElement {
  const box = el('section', { className: 'imports' }, el('h3', { textContent: t.importTitle }), el('p', { className: 'muted', textContent: t.importHint }),
    button(t.findFiles, 'find-files', () => {
      const asked = { projectId: selected, view };
      request('discover', { projectId: asked.projectId }).then(found => {
        if (asked.view !== view) return;
        candidates = found as Candidate[]; candidatesFor = asked.projectId; render();
      }, error => say(errorText(error)));
    }));
  if (candidates) {
    if (!candidates.length) box.append(el('p', { className: 'muted', textContent: t.noFiles }));
    const boxes = candidates.map(candidate => {
      const input = el('input', { type: 'checkbox', checked: candidate.selected, name: `import-${candidate.path}` });
      // The store keeps at most MAX_IMPORTS files per project.
      input.addEventListener('change', () => {
        if (input.checked && boxes.filter(entry => entry.input.checked).length > MAX_IMPORTS) { input.checked = false; say(t.tooManyImports(MAX_IMPORTS)); }
      });
      box.append(el('label', { className: 'check file' }, input, ` ${candidate.path} `, el('span', { className: 'muted', textContent: candidate.kind })));
      return { candidate, input };
    });
    if (candidates.length) {
      box.append(el('div', { className: 'row' }, button(t.saveImports, 'save-imports', () => {
        const imports = boxes.filter(entry => entry.input.checked).map(entry => ({ path: entry.candidate.path, kind: entry.candidate.kind }));
        if (imports.length > MAX_IMPORTS) { say(t.tooManyImports(MAX_IMPORTS)); return; }
        void change('saveImports', { projectId: candidatesFor, imports }).then(next => { if (next) { candidates = null; render(); } });
      })));
    }
  }
  if (importError) box.append(el('p', { className: 'error', textContent: importError }));
  for (const note of importNotes) box.append(el('p', { className: 'muted', textContent: `${note.sourcePath}: ${note.message}` }));
  return box;
}

function memorySection(p: Project): HTMLElement {
  const state = memoryData?.project.id === p.id ? memoryData : null;
  const box = el('section', { className: 'memory' }, el('h3', { textContent: t.memory }), el('p', { className: 'muted', textContent: t.memoryHelp }));
  if (!state) { box.append(el('p', { className: 'muted', textContent: t.noMemory })); return box; }
  const policy = el('input', { type: 'checkbox', checked: state.requireApproval, name: 'memory-approval' });
  policy.addEventListener('change', () => void changeMemory('setMemoryPolicy', { requireApproval: policy.checked }));
  box.append(el('label', { className: 'check' }, policy, ` ${t.requireApproval}`));
  const addText = el('textarea', { name: 'new-memory', rows: 3, placeholder: t.memoryPlaceholder });
  box.append(field(t.remember, addText), button(t.saveMemory, 'save-memory', () => {
    if (addText.value.trim()) void changeMemory('saveMemory', { projectId: p.id, text: addText.value });
  }));
  const entries = el('ul', { className: 'memory-entries' });
  if (!state.records.length) entries.append(el('li', { className: 'muted', textContent: t.noMemory }));
  for (const record of state.records) {
    const textarea = el('textarea', { name: `memory-${record.id}`, rows: 2, value: record.text });
    const metadata = `${record.author} · ${new Date(record.createdAt).toLocaleDateString(locale)} · ${record.approved ? t.approvedMemory : t.pendingMemory}`;
    const controls: Node[] = [el('span', { className: 'muted', textContent: metadata }),
      button(t.saveMemory, `save-memory-${record.id}`, () => void changeMemory('saveMemory', { projectId: p.id, id: record.id, text: textarea.value }))];
    if (!record.approved) controls.push(button(t.approveMemory, `approve-memory-${record.id}`, () => void changeMemory('approveMemory', { projectId: p.id, id: record.id })));
    controls.push(button(t.remove, `remove-memory-${record.id}`, () => void changeMemory('removeMemory', { projectId: p.id, id: record.id })));
    entries.append(el('li', {}, textarea, el('div', { className: 'row' }, ...controls)));
  }
  box.append(entries);
  return box;
}

function previewSection(): HTMLElement {
  const cli = select('preview-cli', [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok'], ['qwen', 'Qwen Code'], ['pi', 'Pi']], previewCli, value => { previewCli = value; });
  const box = el('section', {}, el('h3', { textContent: t.previewTitle }), el('div', { className: 'row' }, cli, button(t.preview, 'preview', () => {
    const asked = view;
    request('preview', { provider: previewCli, ...(selected ? { projectId: selected } : {}) }).then(answer => { if (asked !== view) return; preview = answer as Preview; render(); }, error => say(errorText(error)));
  })));
  if (preview) {
    box.append(el('p', { className: 'muted', textContent: t.previewSize(preview.size, preview.budget, preview.omitted) }),
      el('pre', { className: 'preview', textContent: preview.text || t.previewEmpty }));
  }
  return box;
}

function rulesList(): HTMLUListElement {
  const rules = visibleRules();
  const list = el('ul', { className: 'rules' });
  if (!rules.length) list.append(el('li', { className: 'muted', textContent: t.none }));
  for (const rule of rules) list.append(ruleItem(rule));
  return list;
}

function render(): void {
  if (!data) return;
  const p = project();
  const slot = el('div', {}, rulesList());
  // Search and the category filter redraw only the list, so a rule being typed in the form below is kept.
  const searchInput = el('input', { name: 'search', value: search, placeholder: t.search, type: 'search' });
  searchInput.addEventListener('input', () => { search = searchInput.value; slot.replaceChildren(rulesList()); });
  const categories = select('filter-category', [['', t.allCategories], ...data.categories.map(entry => [entry, categoryLabel(entry)] as [string, string])], filter, value => { filter = value; slot.replaceChildren(rulesList()); });
  root.replaceChildren(
    el('h1', { textContent: t.title }),
    el('p', { className: 'muted', textContent: t.lead }),
    projectsSection(),
    el('section', {}, el('h2', { textContent: t.rulesFor(p?.label ?? t.everyone) }), el('div', { className: 'row' }, searchInput, categories), slot),
    ruleForm(),
    ...(p ? [tasksSection(), importSection(), memorySection(p)] : []),
    previewSection()
  );
}

host.onContext(({ appearance }) => {
  locale = appearance.locale === 'ru' ? 'ru' : 'en';
  t = STRINGS[locale];
  document.documentElement.lang = locale;
  render();
});
load().catch(error => say(errorText(error)));
