export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

export const totalLines = (files) => files.reduce((n, f) => n + f.added + f.removed, 0);

// Reasons to call the paid reviewer. Computed here, never by a model.
export function gate2Triggers({ files, allowedPaths, testFailStreak }, gate2) {
  const out = [];
  const lines = totalLines(files);
  if (lines > gate2.diffLines) out.push(`diff ${lines} lines > ${gate2.diffLines}`);
  for (const f of files) {
    if (matchesAny(f.path, gate2.riskyPaths)) out.push(`risky path: ${f.path}`);
    if (allowedPaths.length > 0 && !matchesAny(f.path, allowedPaths)) {
      out.push(`out of scope: ${f.path}`);
    }
  }
  if (testFailStreak >= gate2.testFailStreak) {
    out.push(`tests red ${testFailStreak} rounds before going green`);
  }
  return out;
}

export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// Fails closed: anything unparseable counts as "changes".
export function parseVerdict(text) {
  const json = extractJson(text);
  if (!json || typeof json !== "object") {
    return { verdict: "changes", issues: ["reviewer reply had no JSON verdict"] };
  }
  const issues = Array.isArray(json.issues) ? json.issues.map(String) : [];
  if (json.verdict === "approve") return { verdict: "approve", issues };
  if (json.verdict === "changes") {
    return { verdict: "changes", issues: issues.length ? issues : ["changes requested"] };
  }
  return { verdict: "changes", issues: ["reviewer verdict was neither approve nor changes"] };
}
