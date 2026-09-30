# Changelog

## Unreleased

Requires the CanvasTTY core with plugin API v2, `launch.delegable` and `cards:decorate`: the upcoming release after 1.7.0.

### What you'll notice

- On a server or in a container, a card with Send rules on shows the badge "Rules not delivered" instead of silently starting without your rules. On this computer and in a worktree nothing changes.
- Codex and Grok no longer refuse rules that merely mention words like "dangerously" or "approval_policy"; only rule text shaped like a CanvasTTY setting or a flag is refused, with the reason.
- Two windows or processes editing the same rules no longer overwrite each other: the second change is refused instead of overwriting the first.
- Switching projects in the settings page no longer shows or saves imported rules, found files or a preview from the project you left.
- Launches with rules and `rules_for` check the project folder once per import instead of once per selected file (up to 32 times).
- Orchestrators can pass `rules_for` launch options to `spawn_agent` on the new core, which refuses undeclared ones.

### Rules store and imports

- A change takes `rules.lock` and checks the revision stored in `rules.json`, not this process's copy; a lock left behind is taken over after 30 s.
- `rules.json` is checked on the opened file (no link, private, bounded), and the rules folder must be a private folder of this user.
- An imported file is read only if the opened file is still the one at its path inside the project, closing a folder-to-link swap between the checks and the open.
- The project folder's identity is checked once per import, and its stat is shared by the per-file checks.
- A saved rule key is one line, and a key is always delivered on one line.

### Delivery

- Rules on servers and containers of CanvasTTY Environments (which leave out launch files and local paths) are not sent, and the card carries the "Rules not delivered" badge; `rules_for` says so too.
- The Codex and Grok argument is judged by its shape as CanvasTTY judges a plugin argument: the key of a `key=value` setting and the name of a flag, not words inside a rule.
- `rules_for` launch options declared `launch.delegable`: they only choose which rules join the prompt.

### Settings page

- Answers for a project that is no longer shown are dropped; found files are saved to the project they were found in; a newly added project is selected by its id; at most as many files can be selected as the store accepts.

### Service transport

- Host calls fail after 30 s and past 64 in flight; all pending calls fail when the host closes the connection.
- Incoming frames are cut from raw bytes at the host's 1 MiB limit; an oversized frame is skipped to its newline. Requests beyond 64 running handlers are answered busy.
- A frame over 1 MiB is never written (an answer becomes an error, a host call fails, an event is dropped with a warning). While the host is not reading, frames wait for `drain` and waiting events and logs are capped at 8 MiB, oldest first; answers and host calls are never dropped.
- On shutdown or end of input the service takes no new work and lets running handlers answer during a short drain.
