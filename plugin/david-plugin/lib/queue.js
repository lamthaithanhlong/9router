import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A route that hands a task to a person-driven app (the Cursor app) through plain files, because the
// app has no API: the plugin writes pending/<id>.md, a person tells the app to process the queue, the
// app moves the file to claimed/ and writes done/<id>.md. Nothing here talks to Cursor.
//
//   pending/   written by the plugin, never edited after
//   claimed/   moved there by the app the moment it starts the task (a rename, so it is atomic)
//   done/      the app's result; the plugin reads it once it has stopped changing
//   expired/   a task nobody picked up in time, or one that never finished (the run moved on)
//   archive/   finished tasks and their results
//
// A task nobody claims within waitMs is withdrawn (moved to expired/) and the call fails, so the
// pipeline falls to the next route on the chain and the same work is never done twice.

export const README = `# david queue

Tasks from the david_run plugin wait here for you to run them in the Cursor app. Say to Cursor:

    Process the david queue in this folder: read README.md and follow it.

## What to do

1. List \`pending/*.md\`, oldest first. Ignore names that start with a dot.
2. For each task, FIRST move it: \`mv pending/<id>.md claimed/<id>.md\`. Moving it is how you say "mine"; the plugin
   stops its timer and waits for you. Do not start work on a file that is still in pending/.
3. Open the claimed file. It names the working directory (\`cwd:\`) and the task. Do the work in that directory:
   edit the files and run the tests it asks for.
4. When finished, write \`done/<id>.md\` in one go, with exactly these sections:

       ## Summary
       what you did, in a few lines

       ## Files changed
       one path per line

       ## Not done
       anything you could not do or are unsure about, or "nothing"

5. Do not touch other tasks' files, do not delete anything here, and do not write outside the task's \`cwd:\`.
   When the queue is empty, say so and stop.

A task that is not claimed within a few minutes is withdrawn and moved to expired/; the plugin has by then sent
the work to another model, so leave expired/ alone.
`;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
export const taskId = (stamp, n, label) => `${stamp}-${String(n).padStart(2, "0")}-${slug(label)}`;
// One source per david_run: the counter is what keeps two tasks with the same label (a fix round reuses "worker-fix") apart.
export function idSource(stamp) {
  let n = 0;
  return (label) => taskId(stamp, ++n, label);
}

export function createQueue({ dir, waitMs = 300_000, claimedWaitMs = 1_800_000, pollMs = 2_000, settleMs = 2_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const sub = (...p) => join(dir, ...p);

  function ensure() {
    for (const d of ["pending", "claimed", "done", "expired", "archive"]) mkdirSync(sub(d), { recursive: true });
    writeFileSync(sub("README.md"), README);
  }

  const move = (from, to) => {
    try {
      renameSync(from, to);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false; // someone else moved it first
      throw e;
    }
  };

  // Resolves to the app's result text. Rejects when nobody picked the task up, when it was claimed but
  // not finished in time, when the call is cancelled, or when the file vanished.
  async function submit({ id, label, role, cwd, prompt, signal }) {
    ensure();
    const file = `${id}.md`;
    const body = [
      "---", `id: ${id}`, `label: ${label}`, `role: ${role}`, `cwd: ${cwd}`, `created: ${new Date(now()).toISOString()}`, "---", "",
      `# TASK ${id}`, "", `Working directory: \`${cwd}\``, "", prompt.trim(), "",
      "---", "When finished, write done/" + file + " as described in README.md (Summary / Files changed / Not done).", "",
    ].join("\n");
    // Written under a dot name and renamed, so the app never sees a half-written task.
    const tmp = sub("pending", `.${file}.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, sub("pending", file));

    const start = now();
    let claimedAt = null;
    let missing = 0;
    for (;;) {
      if (signal?.aborted) {
        move(sub("pending", file), sub("expired", file));
        throw new Error(`cursor queue: ${id} withdrawn because the run was cancelled`);
      }
      const done = sub("done", file);
      if (existsSync(done)) {
        // The app writes the result in one go, but it may be mid-write: wait until the file has stopped changing.
        if (now() - statSync(done).mtimeMs >= settleMs) {
          const text = readFileSync(done, "utf8").trim();
          move(done, sub("archive", `${id}.result.md`));
          move(sub("claimed", file), sub("archive", `${id}.task.md`));
          return text;
        }
        missing = 0;
      } else if (existsSync(sub("claimed", file))) {
        missing = 0;
        claimedAt ??= now();
        if (now() - claimedAt > claimedWaitMs) {
          move(sub("claimed", file), sub("expired", file));
          throw new Error(`cursor queue: ${id} was claimed but not finished within ${Math.round(claimedWaitMs / 60000)} min`);
        }
      } else if (existsSync(sub("pending", file))) {
        missing = 0;
        if (now() - start > waitMs) {
          // If the app claims it at this very moment the rename fails and the next pass sees it in claimed/.
          if (move(sub("pending", file), sub("expired", file))) {
            throw new Error(`cursor queue: nobody picked ${id} up within ${Math.round(waitMs / 60000)} min (tell Cursor to process the david queue); the task was withdrawn`);
          }
        }
      } else if (++missing >= 3) {
        throw new Error(`cursor queue: ${id} disappeared from the queue folder`);
      }
      await sleep(pollMs);
    }
  }

  return { submit, dir, ensure };
}
