import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitChangeSummary } from "../types/qa.js";

const execFileAsync = promisify(execFile);

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: projectPath, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

const lines = (value: string) => value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const normalize = (value: string) => value.replaceAll("\\", "/");
const isQaArtifact = (file: string) => normalize(file) === ".qa-agent" || normalize(file).startsWith(".qa-agent/");
const changedFiles = (value: string) => lines(value).map(normalize).filter((file) => !isQaArtifact(file));

async function numstat(projectPath: string, args: string[]) {
  let additions = 0;
  let deletions = 0;
  try {
    const output = await git(projectPath, args);
    for (const line of lines(output)) {
      const [a, d, ...fileParts] = line.split("\t");
      const file = normalize(fileParts.join("\t"));
      if (file && isQaArtifact(file)) continue;
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
  } catch {}
  return { additions, deletions };
}

async function untrackedStats(projectPath: string, files: string[]) {
  let additions = 0;
  for (const file of files) {
    try {
      const text = await fs.readFile(path.join(projectPath, file), "utf8");
      additions += text.length ? text.split(/\r?\n/).length : 0;
    } catch {}
  }
  return additions;
}

export async function getGitChanges(projectPath: string, base = "HEAD~1"): Promise<GitChangeSummary> {
  try {
    await git(projectPath, ["rev-parse", "--is-inside-work-tree"]);

    let committedFiles: string[] = [];
    try { committedFiles = changedFiles(await git(projectPath, ["diff", "--name-only", `${base}...HEAD`])); } catch {}
    const stagedFiles = changedFiles(await git(projectPath, ["diff", "--cached", "--name-only"]));
    const unstagedFiles = changedFiles(await git(projectPath, ["diff", "--name-only"]));
    const untrackedFiles = changedFiles(await git(projectPath, ["ls-files", "--others", "--exclude-standard"]));

    const all = [...new Set([...committedFiles, ...stagedFiles, ...unstagedFiles, ...untrackedFiles])];

    const committedStats = await numstat(projectPath, ["diff", "--numstat", `${base}...HEAD`]);
    const stagedStats = await numstat(projectPath, ["diff", "--cached", "--numstat"]);
    const unstagedStats = await numstat(projectPath, ["diff", "--numstat"]);
    const untrackedAdditions = await untrackedStats(projectPath, untrackedFiles);

    return {
      base,
      files: all,
      additions: committedStats.additions + stagedStats.additions + unstagedStats.additions + untrackedAdditions,
      deletions: committedStats.deletions + stagedStats.deletions + unstagedStats.deletions,
      committedFiles,
      stagedFiles,
      unstagedFiles,
      untrackedFiles
    };
  } catch {
    return { base, files: [], additions: 0, deletions: 0, committedFiles: [], stagedFiles: [], unstagedFiles: [], untrackedFiles: [] };
  }
}
