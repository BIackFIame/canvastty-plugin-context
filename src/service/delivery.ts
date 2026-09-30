// How each agent CLI receives the rules at launch — the same flags CanvasTTY's #68 chain used (AgentStartup.ts),
// through CanvasTTY's launch contributor. Claude Code reads a file (launch files have no size problem); Codex and Grok
// take the text as one argument, which CanvasTTY caps at 1024 characters without control characters.
import { bytes } from '../shared/rules.ts';

export const DELIVERY_CLIS = ['claude', 'codex', 'grok'] as const;
export type DeliveryCli = typeof DELIVERY_CLIS[number];
export const isDeliveryCli = (value: unknown): value is DeliveryCli => DELIVERY_CLIS.includes(value as DeliveryCli);

export interface Contribution { env: Record<string, string>; secretEnv: Record<string, string>; args: string[]; files: Array<{ relPath: string; content: string }> }

const MAX_ARG = 1024;
// What CanvasTTY refuses in a plugin's launch argument, judged by the argument's shape as the core judges it
// (terminalLaunch.ts coreOwnedLaunchArgument): the key of a `key=value` setting, the name of a flag. Words inside a
// value are the rule's own text, so a rule may say "never bypass review".
/** Setting keys CanvasTTY owns: approvals, the sandbox and its hooks. */
const CORE_CONFIG_KEY = /dangerously|approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|bypass|^hooks(?:\.|$)/iu;
/** A flag whose name asks to skip approvals. */
const CORE_FLAG_WORDS = /dangerously|bypass/iu;
/** `key=value` as a config override writes it: a dotted key of plain name characters, then `=`. */
const CONFIG_PAIR = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)=/u;
/** A whole argument that is one flag (`--yolo`); CanvasTTY owns many of them, so none is sent as rule text. */
const BARE_FLAG = /^-{1,2}[A-Za-z][\w-]*$/u;

/** Why CanvasTTY would refuse `arg` as a launch argument, or null. */
function coreRefusal(arg: string): string | null {
  const configKey = (text: string): string | null => {
    const key = CONFIG_PAIR.exec(text)?.[1];
    return key !== undefined && CORE_CONFIG_KEY.test(key) ? key : null;
  };
  if (arg.startsWith('-')) {
    const inline = arg.startsWith('--config=') ? arg.slice('--config='.length) : /^-c[^=-]/u.test(arg) ? arg.slice(2) : null;
    const key = inline === null ? null : configKey(inline);
    if (key) return `starts with the setting "${key}=", which CanvasTTY keeps for itself`;
    const flag = arg.split('=', 1)[0]!;
    const word = CORE_FLAG_WORDS.exec(flag)?.[0];
    if (word || (inline === null && BARE_FLAG.test(flag))) {
      return `starts with "-", so CanvasTTY reads it as a command-line flag${word ? ` with "${word}"` : ''}`;
    }
    return null;
  }
  const key = configKey(arg);
  return key ? `starts with the setting "${key}=", which CanvasTTY keeps for itself` : null;
}

const tomlString = (text: string): string => JSON.stringify(text).replace(/\u007f/gu, '\\u007f');
const codexArg = (text: string): string => `developer_instructions=${tomlString(text)}`;
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export const DELIVERY: Record<DeliveryCli, { how: string; budget: number; measure(text: string): number }> = {
  // --append-system-prompt-file: added to Claude Code's own system prompt, nothing replaced.
  claude: { how: 'a file appended to the system prompt (--append-system-prompt-file)', budget: 24 * 1024, measure: bytes },
  // Codex developer instructions (-c developer_instructions=…), next to AGENTS.md, not instead of it.
  codex: { how: 'developer instructions (-c developer_instructions=…)', budget: MAX_ARG, measure: text => codexArg(text).length },
  grok: { how: 'rules appended to the system prompt (--rules)', budget: MAX_ARG, measure: text => oneLine(text).length }
};

/** The launch contribution carrying `text` to `cli`; throws with a person-readable reason when it cannot. */
export function contributionFor(cli: DeliveryCli, text: string): Contribution {
  const base: Contribution = { env: {}, secretEnv: {}, args: [], files: [] };
  if (cli === 'claude') {
    return { ...base, args: ['--append-system-prompt-file', '{launchFiles}/rules.md'], files: [{ relPath: 'rules.md', content: text }] };
  }
  const arg = cli === 'codex' ? codexArg(text) : oneLine(text);
  if (arg.length > MAX_ARG) throw new Error(`The rules are ${arg.length} characters as one argument; ${cli === 'codex' ? 'Codex' : 'Grok'} takes at most ${MAX_ARG} at launch.`);
  // `-c` and `--rules` themselves are not CanvasTTY's; the value after them is judged on its own.
  const reason = coreRefusal(arg);
  if (reason) throw new Error(`The rules as ${cli === 'codex' ? 'Codex' : 'Grok'}'s argument ${reason}; reword the first rule or turn off Send rules.`);
  return { ...base, args: cli === 'codex' ? ['-c', arg] : ['--rules', arg] };
}
