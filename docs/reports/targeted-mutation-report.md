# Targeted plugin mutation report

Source commit: dd1cd308dfbd509e6a3eef2c63cae3fe086543f0; tree: 48ffb5333108b6452bffa73667ef7d27eb13b041; runtime: v24.19.0.
The harness archived immutable HEAD, symlinked the existing local node_modules, verified every named baseline test, and applied one mutant at a time only in the temporary archive. Production checkout files were not edited by the harness.

## Mutants

| Mutant | Result | Evidence |
|---|---|---|
| legacy-approved-memory-migrates-as-pending | killed | not ok 1 - legacy project memory is imported as pending and later project-file edits cannot approve it   code: 'ERR_ASSERTION'   name: 'AssertionError' |
| memory-file-stays-outside-project | killed | not ok 1 - a project .canvastty symlink is not used by the private memory store   code: 'ERR_ASSERTION'   name: 'AssertionError' |
| agent-memory-requires-human-approval | killed | not ok 1 - pending project memory stays out of launch summary until a person approves it   code: 'ERR_ASSERTION'   name: 'AssertionError' |
| launch-summary-filters-pending-memory | killed | not ok 1 - pending project memory stays out of launch summary until a person approves it   code: 'ERR_ASSERTION'   name: 'AssertionError' |
| remember-tool-uses-trusted-project-root | killed | not ok 1 - trusted projectRoot keeps launch and memory tools scoped to the original project from a worktree   code: 'ERR_ASSERTION'   name: 'AssertionError' |

Totals: 5 killed by assertions, 0 survived, 0 invalid/setup failures, 0 timed out.
