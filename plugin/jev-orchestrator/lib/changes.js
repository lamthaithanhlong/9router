import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIG = 64 * 1024 * 1024;

// `git diff --numstat` lines: "<added>\t<removed>\t<path>"; binary files show "-".
export function parseNumstat(text) {
  const files = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files.push({
      path: m[3],
      added: m[1] === "-" ? 0 : Number(m[1]),
      removed: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  return files;
}

export function capDiff(diff, max) {
  return diff.length <= max ? diff : `${diff.slice(0, max)}\n[diff truncated: ${diff.length - max} more characters]`;
}

async function git(cwd, args) {
  return (await run("git", args, { cwd, maxBuffer: BIG })).stdout;
}

// Tracked changes against HEAD plus untracked files, without touching the
// index (so it is safe in the user's own checkout).
export async function getChanges(cwd, maxChars) {
  let numstat, diff;
  try {
    numstat = await git(cwd, ["diff", "--numstat", "HEAD"]);
    diff = await git(cwd, ["diff", "HEAD"]);
  } catch {
    numstat = await git(cwd, ["diff", "--numstat"]); // repository without a first commit
    diff = await git(cwd, ["diff"]);
  }
  const files = parseNumstat(numstat);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const path of untracked) {
    let body = "";
    try {
      body = await readFile(join(cwd, path), "utf8");
    } catch {
      // unreadable or binary: counted as one line
    }
    const lines = body === "" ? 1 : body.split("\n").length;
    files.push({ path, added: lines, removed: 0 });
    diff += `\n--- new file: ${path}\n${body.split("\n").map((l) => `+${l}`).join("\n").slice(0, 8000)}\n`;
  }
  return { files, diff: capDiff(diff, maxChars) };
}

// Exit code 0 is a pass. With no command there is nothing to run; the
// pipeline reports that so green does not read as "tested".
export async function runTests(cwd, command, timeoutMs) {
  if (!command) return { passed: true, summary: "no test command given", ran: false };
  try {
    await run("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: BIG });
    return { passed: true, summary: "tests passed", ran: true };
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}` || String(err.message);
    return { passed: false, summary: out.slice(-4000), ran: true };
  }
}
