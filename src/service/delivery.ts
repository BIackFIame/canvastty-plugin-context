// How each agent CLI receives the rules at launch — the same flags CanvasTTY's #68 chain used (AgentStartup.ts),
// through CanvasTTY's launch contributor. Claude Code reads a file (launch files have no size problem); Codex and Grok
// take the text as one argument, which CanvasTTY caps at 1024 characters without control characters.
import { bytes } from '../shared/rules.ts';

export const DELIVERY_CLIS = ['claude', 'codex', 'grok'] as const;
export type DeliveryCli = typeof DELIVERY_CLIS[number];
export const isDeliveryCli = (value: unknown): value is DeliveryCli => DELIVERY_CLIS.includes(value as DeliveryCli);

export interface Contribution { env: Record<string, string>; secretEnv: Record<string, string>; args: string[]; files: Array<{ relPath: string; content: string }> }

const MAX_ARG = 1024;
/** Words CanvasTTY refuses in any plugin argument (they belong to approvals and hooks); an inline rule cannot carry them. */
const CORE_WORDS = /dangerously|approval_policy|approvals_reviewer|sandbox_mode|bypass|^hooks[.=]/iu;

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
  const word = CORE_WORDS.exec(arg)?.[0];
  if (word) throw new Error(`A rule contains "${word}", which CanvasTTY never lets a plugin pass to ${cli === 'codex' ? 'Codex' : 'Grok'} as an argument; reword it or turn off Send rules.`);
  return { ...base, args: cli === 'codex' ? ['-c', arg] : ['--rules', arg] };
}
