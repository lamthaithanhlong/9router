// Scenario script for fake-llm.mjs. Roles are told apart by the model the plugin routed them to:
//   manager-temp = the head agent, cursor-workers = a worker, backup-free = the last-resort route
//   (a worker or a reviewer, told apart by its prompt), anything else = a reviewer.
//
//   A  small change: nothing paid and no backup should run.
//   B  change under src/auth: both paid reviewers must run.
//   C  Cursor out of quota (HTTP 403): the worker must fall back to the backup route.
//   F  like A, but the child tool filter names a tool this Harness does not have (the desktop-profile failure).
//   E  five sub-tasks at once: at most 3 may be in flight on Cursor (the owner was rate-limited).
//   D  change under src/auth with DeepSeek AND Codex out of quota: the reviewers run on the backup route,
//      and because only backup reviewers approved a risky diff the run must stop for a person.
import { readFileSync } from "node:fs";

const QUOTA = { error: { status: 403, message: "quota exceeded" } };
const APPROVE = { content: '{"verdict":"approve","issues":[]}' };

export default function decide({ j, msgs, last, text }) {
  const dir = process.env.E2E_DIR;
  const scen = readFileSync(`${dir}/scenario`, "utf8").trim();
  const repo = `${dir}/repo`;
  if (!(j.tools?.length)) return { content: "title" }; // the session-title helper call
  const hasToolResult = msgs.some((m) => m.role === "tool");
  const firstUser = text(msgs.find((m) => m.role === "user"));
  const risky = scen === "B" || scen === "D";
  const fileOf = (s) => /f\d\.txt/.exec(s)?.[0] ?? "hello.txt";

  const worker = () => {
    const cmd = risky
      ? `cd ${repo} && mkdir -p src/auth && printf 'export const ok = true\\n' > src/auth/login.js`
      : `cd ${repo} && printf hi > ${fileOf(firstUser)}`;
    // scenario E: hold each worker's first request so that several overlap and the cap is visible
    if (!hasToolResult) return { delayMs: scen === "E" ? 900 : 0, tool_calls: [{ name: "bash", args: { command: cmd, description: "Make the change" } }] };
    return { content: `worker done: ${text(last)}` };
  };

  if (j.model === "cursor-workers") return scen === "C" ? QUOTA : worker();
  if (j.model === "backup-free") return firstUser.startsWith("ROLE: worker") ? worker() : APPROVE;
  if (j.model === "manager-temp") {
    const fan = ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"];
    const args = scen === "E"
      ? { task: "create five files", cwd: repo, tasks: fan.map((f) => `create ${f} containing hi`), plan: "no", test_command: "test -f f5.txt" }
      : risky
      ? { task: "add src/auth/login.js", cwd: repo, plan: "no", test_command: "test -f src/auth/login.js", allowed_paths: ["src/**"] }
      : { task: "create hello.txt containing hi", cwd: repo, plan: "no", test_command: "test -f hello.txt" };
    if (!hasToolResult) return { tool_calls: [{ name: "jev_run", args }] };
    return { content: `HEAD FINAL REPORT:\n${text(last)}` };
  }
  // deepseek-v4.1-flash, codex-head: the paid reviewers
  return scen === "D" ? QUOTA : APPROVE;
}
