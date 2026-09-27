# CanvasTTY Context

Project rules for agents in [CanvasTTY](https://github.com/howdeploy/CanvasTTY): the conventions you would otherwise
repeat in every prompt, kept per project and sent to an agent when you launch it.

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

## Sending rules to an agent

Trust the plugin's native code (Settings → Plugins), then in the launcher open **Advanced → Use CanvasTTY Context**:

| Field | Meaning |
|:--|:--|
| Send rules | On by default; off sends nothing for this launch |
| Saved task | Adds that task's rules (tasks are listed with their project) |
| Only this category | Only one category (security and dependencies always) |
| Instruction for this launch | One more rule, stronger than all others, for this launch only |

The rules for the card's folder are resolved at every start (restart and restore included), so a changed rule or file
applies at the next start. How each agent gets them — the flags CanvasTTY's own context layer used:

| Agent | Delivery | Size |
|:--|:--|:--|
| Claude Code | a launch file, `--append-system-prompt-file` (added to its system prompt) | 24 KB |
| Codex | `-c developer_instructions="…"` (next to `AGENTS.md`) | 1024 characters as one argument |
| Grok | `--rules "…"` | 1024 characters |

Rules that do not fit are left out whole and the preview says how many; a security, dependencies or launch
instruction that does not fit refuses the launch with the reason instead. Other agents have no launch flag for this and
are not offered the option.

## Orchestrators

`canvastty-context__rules_for` (orchestrators and subagents) answers which rules apply to a folder (default: the
caller's), optionally for a saved task or one category: the rules in order, the exact text, and `launchOptions` to pass
to `spawn_agent` so a Claude Code, Codex or Grok subagent gets them at launch.

## Storage

Projects, tasks and rules live in `rules/rules.json` (private file) in the plugin's data folder, apart from any
settings; every change is checked against the revision the settings page last read. Uninstalling the plugin removes it.

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
