// Design tokens and checkable conventions (#68, src/shared/conventions.ts). A `validate.*` rule is structured JSON in a
// narrow vocabulary that an agent (or a later checker) can apply mechanically; the plugin checks its shape when it is
// saved and sends it to agents like any other rule. Nothing here runs a check on the person's files.
import type { Category, RuleValue } from './rules.ts';

export type ConventionRule =
  | { kind: 'forbidden-colors'; colors: string[] }
  | { kind: 'forbidden-pair'; foreground: string; background: string }
  | { kind: 'formatter-config'; file: string; required: Record<string, string | number | boolean> }
  | { kind: 'filename'; extension: 'ts' | 'tsx' | 'js' | 'jsx' | 'css'; style: 'kebab-case' | 'camelCase' | 'PascalCase' }
  | { kind: 'dependencies'; section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'; allow?: string[]; deny?: string[] };

const color = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(v);

/** The convention in a `validate.*` value, or undefined when the value is not one of the supported shapes. */
export function parseConventionRule(value: RuleValue): ConventionRule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const fields = (keys: string[]): boolean => Object.keys(value).every(k => keys.includes(k));
  const list = (v: unknown, valid: (s: unknown) => boolean): boolean => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(valid);
  if (value.kind === 'forbidden-colors' && fields(['kind', 'colors']) && list(value.colors, color)) return value as ConventionRule;
  if (value.kind === 'forbidden-pair' && fields(['kind', 'foreground', 'background']) && color(value.foreground) && color(value.background)) return value as ConventionRule;
  if (value.kind === 'filename' && fields(['kind', 'extension', 'style']) && ['ts', 'tsx', 'js', 'jsx', 'css'].includes(String(value.extension))
    && ['kebab-case', 'camelCase', 'PascalCase'].includes(String(value.style))) return value as ConventionRule;
  if (value.kind === 'formatter-config' && fields(['kind', 'file', 'required']) && typeof value.file === 'string'
    && /^(?:\.prettierrc(?:\.(?:json|ya?ml))?|\.eslintrc\.(?:json|ya?ml))$/u.test(value.file) && value.required && typeof value.required === 'object'
    && !Array.isArray(value.required) && Object.keys(value.required).length > 0 && Object.keys(value.required).length <= 16
    && Object.entries(value.required).every(([k, v]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(k) && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 120))) return value as ConventionRule;
  const dependency = (v: unknown): boolean => typeof v === 'string' && /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/u.test(v);
  if (value.kind === 'dependencies' && fields(['kind', 'section', 'allow', 'deny']) && ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(String(value.section))
    && (value.allow !== undefined || value.deny !== undefined) && (value.allow === undefined || list(value.allow, dependency)) && (value.deny === undefined || list(value.deny, dependency))) return value as ConventionRule;
  return;
}

/** A `validate.*` key must carry a supported convention; other keys are free text or JSON. */
export function conventionProblem(key: string, value: RuleValue): string | null {
  if (!key.startsWith('validate.')) return null;
  return parseConventionRule(value) ? null : 'A validate.* rule needs one of the checkable convention shapes (use a preset).';
}

export interface Preset { id: string; en: string; ru: string; key: string; category: Category; value: RuleValue }

export const CONVENTION_PRESETS: Preset[] = [
  { id: 'colors', en: 'Forbidden color', ru: 'Запрещённый цвет', key: 'validate.colors', category: 'design', value: { kind: 'forbidden-colors', colors: ['#000000'] } },
  { id: 'pair', en: 'Forbidden color pair', ru: 'Пара цветов', key: 'validate.pair', category: 'design', value: { kind: 'forbidden-pair', foreground: '#000000', background: '#ffffff' } },
  { id: 'formatter', en: 'Formatter settings', ru: 'Настройки форматтера', key: 'validate.formatter', category: 'code-style', value: { kind: 'formatter-config', file: '.prettierrc.json', required: { semi: true } } },
  { id: 'filenames', en: 'File names', ru: 'Имена файлов', key: 'validate.filenames', category: 'naming', value: { kind: 'filename', extension: 'tsx', style: 'PascalCase' } },
  { id: 'dependencies', en: 'Dependencies', ru: 'Зависимости', key: 'validate.dependencies', category: 'dependencies', value: { kind: 'dependencies', section: 'dependencies', deny: ['example-package'] } }
];

/** Design token starters: explicit values an agent should use (CSS imports create `design.css.*` keys instead). */
export const TOKEN_PRESETS: Preset[] = [
  { id: 'color', en: 'Color', ru: 'Цвет', key: 'design.colors.name', category: 'design', value: '#000000' },
  { id: 'typography', en: 'Typography', ru: 'Типографика', key: 'design.typography.name', category: 'design', value: '16px/1.5 system-ui' },
  { id: 'spacing', en: 'Spacing', ru: 'Отступ', key: 'design.spacing.name', category: 'design', value: '8px' },
  { id: 'radius', en: 'Radius', ru: 'Радиус', key: 'design.radius.name', category: 'design', value: '6px' },
  { id: 'component', en: 'Component colors', ru: 'Цвета компонента', key: 'design.components.name', category: 'design', value: { foreground: '#000000', background: '#ffffff' } }
];
