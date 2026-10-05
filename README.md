# CanvasTTY Context

> **Requires the CanvasTTY core with plugin API v2** (plugin services, launch contributors, session environments, decision hooks, plugin tools and card actions, `launch.delegable` and `cards:decorate`): the upcoming release after 1.7.0. CanvasTTY 1.7.0 and earlier do not have these extension points, so installing it there fails the manifest check.

Project rules for agents in [CanvasTTY](https://github.com/howdeploy/CanvasTTY): the conventions you would otherwise
repeat in every prompt, kept per project and sent to Claude Code, Codex, Grok, Qwen Code or Pi when you launch with Send rules.

- **Rules** for you (all projects), defaults, an organization, a project or a saved task, each with a category
  (design, architecture, code style, security, testing, …), a key and a text or JSON value. A more specific rule with
  the same key wins: the launch's own instruction → task → project → organization → user → defaults; at one scope your
  own rule beats an imported one. Security and dependencies rules are never filtered out or cut.
- **Imports from project files**, read when rules are needed (no background scan): `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `CONTRIBUTING.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, Cursor rules
  with `alwaysApply: true`, README development/testing/code-style sections, `.editorconfig`, Prettier/ESLint JSON
  configs and CSS custom properties of selected theme blocks. JavaScript configs are never run; YAML configs are listed,
  not parsed. Reads stay inside the project folder (no links, 64 KB a file, 256 KB together). **Override** turns an
  imported row into your own editable rule with the same key.
- **Design tokens and checkable conventions**: starters for colors, typography, spacing, radius and component colors,
  and `validate.*` JSON presets (forbidden colors or color pairs, formatter settings, file names, dependencies) whose
  shape is checked when saved.
- **Project memory**: agents can suggest durable facts with `remember` and query approved facts with `recall`. The
  shared, human-readable `.canvastty/memory.json` is confined to a registered project and secret-masked before saving.
  Agent suggestions wait for approval by default; people can edit, approve or remove each item in Settings, or turn off
  approval for that project. Records show author and date. Only approved memory is sent at launch, capped at 4 KiB
  (and within each CLI's smaller argument limit).

## Sending rules to an agent

Trust the plugin's native code (Settings → Plugins), then in the launcher open **Advanced → Use CanvasTTY Context**:

| Field | Meaning |
|:--|:--|
| Send rules | On by default; off sends nothing for this launch |
| Saved task | Adds that task's rules (tasks are listed with their project) |
| Only this category | Only one category (security and dependencies always) |
| Instruction for this launch | One more rule, stronger than all others, for this launch only |

The rules for the card's folder are resolved at every start (restart and restore included), so a changed rule or file
applies at the next start. How each supported agent gets them:

| Agent | Delivery | Size |
|:--|:--|:--|
| Claude Code | a launch file, `--append-system-prompt-file` (added to its system prompt) | 24 KB |
| Codex | `-c developer_instructions="…"` (next to `AGENTS.md`) | 1024 characters as one argument |
| Grok | `--rules "…"` | 1024 characters |
| Qwen Code | [`--append-system-prompt "…"`](https://github.com/QwenLM/qwen-code-docs/blob/main/website/content/en/users/features/headless.md) for this run | 1024 characters |
| Pi | [`--append-system-prompt "…"`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) for this run | 1024 characters |

Rules that do not fit are left out whole and the preview says how many; a security, dependencies or launch
instruction that does not fit refuses the launch with the reason instead. Qwen Code and Pi use a per-run append flag;
Pi text is prefixed so it cannot be mistaken for the flag's optional file-path form. The plugin does not write user CLI
configuration or permissions. Other agents start with a **Rules not delivered** badge and a `rules_for`/`recall` fallback
until a safe per-run instruction channel is confirmed.

CanvasTTY refuses plugin arguments that set its own approvals, sandbox or hooks, so the Codex and Grok argument is
judged by its shape the same way: a rule may say "never bypass review", but rules whose text starts like such a setting
(`sandbox_mode=…`) or like a command-line flag are refused with the reason; reword the first rule.

## Orchestrators

`canvastty-context__rules_for` (orchestrators and subagents) answers which rules apply to a folder (default: the
caller's), optionally for a saved task or one category: the rules in order, the exact text, and `launchOptions` to pass
to `spawn_agent` so a Claude Code, Codex, Grok, Qwen Code or Pi subagent gets them at launch. The launch options are declared
delegable (`launch.delegable`; CanvasTTY refuses undeclared ones in `spawn_agent`): they only choose which rules are added to the agent's prompt, never a permission.

## Servers and containers

Rules travel with the launch (a file for Claude Code and arguments for Codex, Grok, Qwen Code and Pi). On this computer and in a
CanvasTTY Environments worktree they reach the agent. Servers (ssh) and containers do not pass the launch's files and
local paths on, so a card there with **Send rules** on starts without the rules and carries the badge *Rules not
delivered* ("project rules are not delivered on this server/container"); give the agent the text of `rules_for` in its
prompt if it needs them. Another plugin's environment is treated the same way, since the plugin cannot tell whether it
passes the launch on. The badge needs the `cards:decorate` permission.

## Storage

Projects, tasks, rules and approval policy live in `rules/rules.json` (private file) in the plugin's data folder, apart from any
settings; each project's `.canvastty/memory.json` remains with that project. Rule changes take `rules/rules.lock` and are checked against the revision stored in the file, so a second writer on
the same folder is refused instead of overwritten (a lock left behind is taken over after 30 s). Uninstalling removes the plugin's data; project memory stays in the project.
Between the service and CanvasTTY a frame is at most 1 MiB, a host call fails after 30 s or past 64 in flight, and
waiting events and logs are capped at 8 MiB.

## Not ported from CanvasTTY #68

Learning from corrections, data classes (floors and per-route ceilings — CanvasTTY's core has no route data class to
compare with), the snapshot validator for capsules, ACP per-task refresh, the launcher route preview across hosts, and
YAML config parsing.

## Build and test

```
npm install        # or ESBUILD=/path/to/esbuild
npm run build      # bundles services/context.mjs and settings/context.js, stamps coreFiles
npm test           # CANVASTTY_REPO=/path/to/CanvasTTY also runs CanvasTTY's validator, supervisor and launch pipeline
```
