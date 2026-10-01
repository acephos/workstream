#!/usr/bin/env node
import { Harness, parseRole } from "./harness.js";
import { StorageError } from "./storage.js";
import { parseArgs, flagBool, flagString } from "./cli/args.js";
import type { Session, WorkspaceConfig } from "./types.js";

const VERSION = "0.1.0";

function printHelp(): void {
  const text = `
workstream (ws) — multi-session agent orchestration harness

Usage:
  ws init [name] [--adapter mock|openai] [--model <id>] [--force]
  ws spawn --name <n> --role fast|good --prompt "..." [--criteria <file>] [--no-run]
  ws send <name> "<message>"
  ws list
  ws wait <name> [--timeout <ms>] [--mark-only]
  ws status
  ws check [name] [--run-checks]
  ws done <name>
  ws help
  ws version

Environment:
  WORKSTREAM_API_KEY     API key for openai adapter
  WORKSTREAM_BASE_URL    OpenAI-compatible base URL (default https://api.openai.com/v1)
  WORKSTREAM_MODEL       Default model id

Local state lives in .workstream/ (config + per-session JSON logs).
Mock adapter is default — full CLI works offline.
`.trim();
  console.log(text);
}

function formatSessionRow(s: Session): string {
  const updated = s.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const criteria = s.criteriaFile ? ` criteria=${s.criteriaFile}` : "";
  return `${s.name.padEnd(16)} ${s.role.padEnd(5)} ${s.status.padEnd(8)} turns=${String(s.turns.length).padStart(3)}  ${updated}${criteria}`;
}

function printStatus(config: WorkspaceConfig, sessions: Session[]): void {
  console.log(`workspace: ${config.name}`);
  console.log(`adapter:   ${config.adapter}${config.model ? ` (model=${config.model})` : ""}`);
  console.log(`sessions:  ${sessions.length}`);
  if (sessions.length === 0) {
    console.log("(none)");
    return;
  }
  console.log("");
  console.log("NAME             ROLE  STATUS   TURNS  UPDATED");
  for (const s of sessions) {
    console.log(formatSessionRow(s));
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  const harness = new Harness();

  try {
    switch (command) {
      case "help":
      case "-h":
      case "--help": {
        printHelp();
        return 0;
      }
      case "version":
      case "-V":
      case "--version": {
        console.log(VERSION);
        return 0;
      }
      case "init": {
        const name =
          positionals[0] ??
          flagString(flags, "name", "n") ??
          "workstream";
        const adapterRaw = flagString(flags, "adapter") ?? "mock";
        if (adapterRaw !== "mock" && adapterRaw !== "openai") {
          throw new StorageError(`Invalid --adapter "${adapterRaw}". Use mock|openai.`);
        }
        const model = flagString(flags, "model");
        const force = flagBool(flags, "force", "f");
        const config = await harness.init(name, {
          adapter: adapterRaw,
          model,
          force,
        });
        console.log(`Initialized workspace "${config.name}" (adapter=${config.adapter})`);
        console.log("State directory: .workstream/");
        return 0;
      }
      case "spawn": {
        const name = flagString(flags, "name", "n");
        const roleRaw = flagString(flags, "role", "r");
        const prompt = flagString(flags, "prompt", "p") ?? positionals[0];
        const criteria = flagString(flags, "criteria", "c");
        const noRun = flagBool(flags, "no-run");

        if (!name) throw new StorageError("spawn requires --name <n>");
        if (!roleRaw) throw new StorageError("spawn requires --role fast|good");
        if (!prompt) throw new StorageError('spawn requires --prompt "..."');

        const role = parseRole(roleRaw);
        const session = await harness.spawn({
          name,
          role,
          prompt,
          criteriaFile: criteria,
          run: !noRun,
        });

        console.log(`spawned ${session.name} role=${session.role} status=${session.status}`);
        const last = session.turns[session.turns.length - 1];
        if (last?.role === "assistant") {
          console.log("---");
          console.log(last.content);
        }
        return 0;
      }
      case "send": {
        const name = positionals[0] ?? flagString(flags, "name", "n");
        const message =
          positionals.slice(1).join(" ") ||
          flagString(flags, "message", "m") ||
          "";
        if (!name) throw new StorageError("send requires <name>");
        if (!message) throw new StorageError('send requires a message: ws send <name> "..."');

        const session = await harness.send(name, message);
        console.log(`sent → ${session.name} status=${session.status}`);
        const last = session.turns[session.turns.length - 1];
        if (last?.role === "assistant") {
          console.log("---");
          console.log(last.content);
        }
        return 0;
      }
      case "list": {
        const sessions = await harness.list();
        if (sessions.length === 0) {
          console.log("(no sessions)");
          return 0;
        }
        console.log("NAME             ROLE  STATUS   TURNS  UPDATED");
        for (const s of sessions) {
          console.log(formatSessionRow(s));
        }
        return 0;
      }
      case "wait": {
        const name = positionals[0] ?? flagString(flags, "name", "n");
        if (!name) throw new StorageError("wait requires <name>");
        const timeoutRaw = flagString(flags, "timeout", "t");
        const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 0;
        if (timeoutRaw && !Number.isFinite(timeoutMs)) {
          throw new StorageError(`Invalid --timeout "${timeoutRaw}"`);
        }
        const markOnly = flagBool(flags, "mark-only");
        const session = await harness.wait(name, { timeoutMs, markOnly });
        console.log(`wait ${session.name} status=${session.status}`);
        return 0;
      }
      case "status": {
        const overview = await harness.status();
        printStatus(overview.config, overview.sessions);
        console.log("");
        console.log(
          `counts: idle=${overview.counts.idle} running=${overview.counts.running} waiting=${overview.counts.waiting} done=${overview.counts.done} failed=${overview.counts.failed}`,
        );
        return 0;
      }
      case "check": {
        const name = positionals[0];
        const results = await harness.check(name, { runCommands: flagBool(flags, "run-checks") });
        if (results.length === 0) {
          console.log("(no sessions to check)");
          return 0;
        }
        let allOk = true;
        for (const r of results) {
          const badge = r.ok ? "PASS" : "FAIL";
          console.log(`[${badge}] ${r.session}${r.criteriaFile ? ` (${r.criteriaFile})` : ""}`);
          for (const note of r.notes) {
            console.log(`  · ${note}`);
          }
          for (const m of r.missing) {
            console.log(`  ✗ missing: ${m}`);
          }
          if (!r.ok) allOk = false;
        }
        return allOk ? 0 : 1;
      }
      case "done": {
        const name = positionals[0] ?? flagString(flags, "name", "n");
        if (!name) throw new StorageError("done requires <name>");
        const session = await harness.setStatus(name, "done");
        console.log(`marked ${session.name} status=done`);
        return 0;
      }
      default: {
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
      }
    }
  } catch (err) {
    if (err instanceof StorageError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
