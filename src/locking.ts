import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveSessionPath, StorageError } from "./storage.js";

/** Serialize a complete mutation across Harness instances and local CLI processes. */
export async function withSessionLock<T>(name: string, cwd: string, work: () => Promise<T>): Promise<T> {
  const lock = `${resolveSessionPath(name, cwd)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await mkdir(lock);
      try {
        await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed local process cannot still be writing. Never expire a live owner's lease.
      try {
        const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { pid: number };
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              throw new StorageError(`Abandoned session lock for ${name}; verify no writer is active, then remove ${lock}.`);
            }
          }
        }
      } catch (probe) {
        if (probe instanceof StorageError) throw probe;
        // The owner may still be creating its marker. Retry, then fail safely.
      }
      if (Date.now() >= deadline) throw new StorageError(`Timed out waiting for session lock: ${lock}`);
      await sleep(20);
    }
  }
  try { return await work(); } finally {
    // Only our own lease can be released.
    const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { token: string };
    if (owner.token === token) await rm(lock, { recursive: true });
  }
}
