import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "dist", "cli.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      // Force offline: never accidentally hit network in tests
      WORKSTREAM_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (err) => {
    resolve({ code: 1, stdout, stderr: String(err) });
  });
  child.on("close", (code) => {
    resolve({ code: code ?? 1, stdout, stderr });
  });
  });
}

describe("CLI integration (mock adapter)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "ws-cli-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("init → spawn → send → list → status smoke", async () => {
    let r = await runCli(["init", "demo"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Initialized workspace "demo"/);

    r = await runCli(
      [
        "spawn",
        "--name",
        "frontend",
        "--role",
        "fast",
        "--prompt",
        "Build the login form",
      ],
      cwd,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /spawned frontend/);
    assert.match(r.stdout, /mock\/fast/);

    r = await runCli(["send", "frontend", "Add validation messages"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /sent → frontend/);

    r = await runCli(["list"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /frontend/);
    assert.match(r.stdout, /fast/);

    r = await runCli(["status"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /workspace: demo/);
    assert.match(r.stdout, /adapter:\s+mock/);
    assert.match(r.stdout, /frontend/);

    r = await runCli(["wait", "frontend", "--mark-only"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /status=waiting/);

    r = await runCli(["done", "frontend"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /status=done/);
  });

  it("check fails then passes with criteria", async () => {
    await runCli(["init", "contracts"], cwd);
    await mkdir(path.join(cwd, "criteria"), { recursive: true });
    await writeFile(
      path.join(cwd, "criteria", "ship.txt"),
      'command:["node","-e","process.exit(0)"]\n',
      "utf8",
    );

    let r = await runCli(
      [
        "spawn",
        "--name",
        "shipper",
        "--role",
        "good",
        "--prompt",
        "Close the milestone",
        "--criteria",
        "criteria/ship.txt",
        "--no-run",
      ],
      cwd,
    );
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["check", "shipper"], cwd);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL/);

    r = await runCli(["send", "shipper", "delivery complete — ready to merge"], cwd);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(["check", "shipper", "--run-checks"], cwd);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS/);
  });

  it("version and help exit 0", async () => {
    let r = await runCli(["version"], cwd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0\.1\.0/);

    r = await runCli(["help"], cwd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /workstream/);
  });

  it("errors without init", async () => {
    const r = await runCli(["list"], cwd);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ws init/i);
  });
});
