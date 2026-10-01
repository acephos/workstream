import { readFile, stat, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CheckResult, Session } from "./types.js";
import { writeJsonAtomic, resolveWorkstreamRoot } from "./storage.js";

async function workspacePath(cwd: string, name: string): Promise<string> {
  const root = await realpath(cwd);
  const target = await realpath(path.resolve(cwd, name));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Evidence must be inside the workspace");
  }
  return target;
}

async function runCheck(argv: string[], cwd: string, timeoutMs: number) {
  const startedAt = new Date().toISOString();
  const digest = createHash("sha256");
  let error: string | undefined;
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => digest.update(chunk));
    child.stderr.on("data", chunk => digest.update(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, timeoutMs);
    child.on("error", err => { error = err.message; });
    child.on("close", code => { clearTimeout(timer); resolve(code); });
  });
  return { argv, startedAt, finishedAt: new Date().toISOString(), exitCode, timedOut, error, outputSha256: digest.digest("hex"), ok: exitCode === 0 && !timedOut && !error };
}

/** Evidence checks: file hashes or explicitly enabled host commands, never transcript claims. */
export async function checkDeliveryContract(session: Session, cwd: string, options: { runCommands?: boolean; timeoutMs?: number } = {}): Promise<CheckResult> {
  const notes: string[] = [];
  const missing: string[] = [];
  const result = () => ({ session: session.name, ok: missing.length === 0, criteriaFile: session.criteriaFile, missing, notes });
  if (!session.criteriaFile) { missing.push("No criteria file; completion is unverified."); return result(); }
  let raw: string;
  try { raw = await readFile(await workspacePath(cwd, session.criteriaFile), "utf8"); }
  catch { missing.push(`criteria file missing or outside workspace: ${session.criteriaFile}`); return result(); }
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!lines.length) { missing.push("Empty criteria file; completion is unverified."); return result(); }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Check timeout must be positive");
  for (const line of lines) {
    if (line.startsWith("file:")) {
      const name = line.slice(5).trim();
      try {
        const target = await workspacePath(cwd, name);
        if (!(await stat(target)).isFile()) throw new Error("not a file");
        const hash = createHash("sha256").update(await readFile(target)).digest("hex");
        notes.push(`present: file:${name} sha256=${hash} (artifact presence, not behavior verification)`);
      } catch { missing.push(line); }
    } else if (line.startsWith("command:")) {
      try {
        const argv: unknown = JSON.parse(line.slice(8));
        if (!Array.isArray(argv) || !argv.length || !argv.every(x => typeof x === "string" && x.length > 0)) throw new Error("Expected a nonempty JSON argv array");
        if (!options.runCommands) { missing.push(`${line} (requires --run-checks)`); continue; }
        const receipt = await runCheck(argv, cwd, timeoutMs);
        const receiptPath = path.join(resolveWorkstreamRoot(cwd), "evidence", `${session.name}-${randomUUID()}.json`);
        await writeJsonAtomic(receiptPath, { session: session.name, criteriaSha256: createHash("sha256").update(raw).digest("hex"), ...receipt });
        notes.push(`host check receipt: ${path.relative(cwd, receiptPath)}`);
        if (!receipt.ok) missing.push(`${line} (exit=${receipt.exitCode}, timedOut=${receipt.timedOut}${receipt.error ? `, error=${receipt.error}` : ""})`);
      } catch (error) { missing.push(`${line}: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      missing.push(`${line}: transcript claims cannot verify completion; use file: or command:["executable","arg"]`);
    }
  }
  return result();
}
