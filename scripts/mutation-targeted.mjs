#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repoRoot, "docs", "reports", "targeted-mutation-report.md");
const mutants = [
  {
    "id": "legacy-approved-memory-migrates-as-pending",
    "file": "src/service/memory.ts",
    "before": "return structuredClone(value.records).map(record => ({ ...record, approved: false }));",
    "after": "return structuredClone(value.records).map(record => ({ ...record, approved: record.approved }));",
    "test": "tests/memory.test.mjs",
    "pattern": "legacy project memory is imported as pending and later project-file edits cannot approve it"
  },
  {
    "id": "memory-file-stays-outside-project",
    "file": "src/service/memory.ts",
    "before": "this.file = join(this.directory, `${name}.json`);",
    "after": "this.file = join(this.root, '.canvastty', 'memory.json');",
    "test": "tests/memory.test.mjs",
    "pattern": "a project .canvastty symlink is not used by the private memory store"
  },
  {
    "id": "agent-memory-requires-human-approval",
    "file": "src/service/context.ts",
    "before": "approved: !this.requireMemoryApproval",
    "after": "approved: true",
    "test": "tests/memory.test.mjs",
    "pattern": "pending project memory stays out of launch summary until a person approves it"
  },
  {
    "id": "launch-summary-filters-pending-memory",
    "file": "src/service/context.ts",
    "before": "const approved = records.filter(record => record.approved).slice(-20);",
    "after": "const approved = records.slice(-20);",
    "test": "tests/memory.test.mjs",
    "pattern": "pending project memory stays out of launch summary until a person approves it"
  },
  {
    "id": "remember-tool-uses-trusted-project-root",
    "file": "src/service/context.ts",
    "before": "private async remember(input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {\n    const cwd = caller?.projectRoot ?? caller?.cwd ?? caller?.workingDirectory;",
    "after": "private async remember(input: Record<string, unknown>, caller: Caller | undefined): Promise<{ content: unknown; isError?: boolean }> {\n    const cwd = caller?.cwd ?? caller?.workingDirectory;",
    "test": "tests/memory.test.mjs",
    "pattern": "trusted projectRoot keeps launch and memory tools scoped to the original project from a worktree"
  }
];

function runTarget(testFile, pattern, cwd) {
  const args = [
    "--experimental-strip-types", "--no-warnings", "--test", "--test-concurrency=1",
    "--test-reporter=tap", "--test-name-pattern", pattern, testFile
  ];
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: "1"
  };
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return {
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal !== null,
    matched: (result.stdout || "").includes("# Subtest: " + pattern),
    output: [result.stdout || "", result.stderr || "", result.error?.message || ""].filter(Boolean).join("\n")
  };
}

function summaryCount(output, name) {
  const match = new RegExp("^# " + name + " (\\d+)$", "m").exec(output);
  return match ? Number(match[1]) : 0;
}

function failureEvidence(output) {
  return output.split("\n")
    .filter(line => /AssertionError|ERR_ASSERTION|^not ok /u.test(line))
    .slice(-8).join(" ").slice(0, 600);
}

function classify(result) {
  if (result.timedOut) return "timedout";
  if (result.exitCode === 0 && result.matched && summaryCount(result.output, "pass") > 0) return "survived";
  if (result.exitCode !== 0 && result.matched && /AssertionError|ERR_ASSERTION/u.test(result.output)) return "killed";
  return "invalid";
}

const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repoRoot, encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", "--verify", commit + "^{tree}"], { cwd: repoRoot, encoding: "utf8" }).trim();
const copyRoot = mkdtempSync(join(tmpdir(), "canvastty-plugin-mutation-"));
let report;
try {
  const archive = execFileSync("git", ["archive", "--format=tar", commit], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", copyRoot], { input: archive });
  const modules = join(repoRoot, "node_modules");
  if (!existsSync(modules)) throw new Error("Local node_modules is required; no package install was attempted.");
  symlinkSync(modules, join(copyRoot, "node_modules"), "dir");

  const patterns = new Map();
  for (const mutant of mutants) {
    const key = mutant.test + "\n" + mutant.pattern;
    if (!patterns.has(key)) patterns.set(key, mutant);
  }
  for (const mutant of patterns.values()) {
    const baseline = runTarget(mutant.test, mutant.pattern, copyRoot);
    if (baseline.exitCode !== 0 || !baseline.matched || summaryCount(baseline.output, "pass") < 1) {
      throw new Error("Baseline did not execute and pass target '" + mutant.pattern + "' in " + mutant.test + ".\n" + baseline.output);
    }
  }

  const results = [];
  for (const mutant of mutants) {
    const path = join(copyRoot, mutant.file);
    if (!existsSync(path)) {
      results.push({ id: mutant.id, status: "invalid", evidence: "source file absent from archived HEAD" });
      continue;
    }
    const pristine = readFileSync(path, "utf8");
    const matches = pristine.split(mutant.before).length - 1;
    if (matches !== 1) {
      results.push({ id: mutant.id, status: "invalid", evidence: "anchor matched " + matches + " times" });
      continue;
    }
    writeFileSync(path, pristine.replace(mutant.before, mutant.after));
    let run;
    try {
      run = runTarget(mutant.test, mutant.pattern, copyRoot);
    } finally {
      writeFileSync(path, pristine);
    }
    const status = classify(run);
    results.push({
      id: mutant.id, status,
      evidence: status === "killed" ? failureEvidence(run.output)
        : status === "survived" ? "target assertion passed with the mutation"
        : status === "timedout" ? "focused test exceeded 30 seconds"
        : "test/setup failure without a matching AssertionError: " + failureEvidence(run.output)
    });
  }

  const totals = { killed: 0, survived: 0, invalid: 0, timedout: 0 };
  for (const row of results) totals[row.status]++;
  report = { commit, tree, node: execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim(), baselinePatterns: patterns.size, totals, results };
  const lines = [
    "# Targeted plugin mutation report", "",
    "Source commit: " + commit + "; tree: " + tree + "; runtime: " + report.node + ".",
    "The harness archived immutable HEAD, symlinked the existing local node_modules, verified every named baseline test, and applied one mutant at a time only in the temporary archive. Production checkout files were not edited by the harness.", "",
    "## Mutants", "",
    "| Mutant | Result | Evidence |", "|---|---|---|",
    ...results.map(row => "| " + row.id + " | " + row.status + " | " + (row.evidence || "—").replaceAll("|", "\\\\|") + " |"),
    "", "Totals: " + totals.killed + " killed by assertions, " + totals.survived + " survived, " + totals.invalid + " invalid/setup failures, " + totals.timedout + " timed out.",
    ""
  ];
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, lines.join("\n"));
  console.log(JSON.stringify({ commit, tree, baselinePatterns: patterns.size, totals, results }, null, 2));
  if (totals.survived || totals.invalid || totals.timedout) process.exitCode = 1;
} finally {
  rmSync(copyRoot, { recursive: true, force: true });
}

