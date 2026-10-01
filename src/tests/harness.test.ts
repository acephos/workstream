import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../harness.js";
import { MockAdapter } from "../adapters/mock.js";
import { StorageError } from "../storage.js";
import { parseArgs, flagString, flagBool } from "../cli/args.js";

describe("parseArgs", () => {
  it("parses command, flags, and positionals", () => {
    const parsed = parseArgs([
      "spawn",
      "--name",
      "auth",
      "--role",
      "fast",
      "--prompt",
      "ship it",
      "--no-run",
    ]);
    assert.equal(parsed.command, "spawn");
    assert.equal(flagString(parsed.flags, "name"), "auth");
    assert.equal(flagString(parsed.flags, "role"), "fast");
    assert.equal(flagString(parsed.flags, "prompt"), "ship it");
    assert.equal(flagBool(parsed.flags, "no-run"), true);
  });

  it("supports --key=value", () => {
    const parsed = parseArgs(["send", "worker", "--message=hello"]);
    assert.equal(parsed.command, "send");
    assert.deepEqual(parsed.positionals, ["worker"]);
    assert.equal(flagString(parsed.flags, "message"), "hello");
  });
});

describe("Harness", () => {
  let cwd: string;
  let harness: Harness;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "workstream-"));
    harness = new Harness({ cwd, adapter: new MockAdapter() });
    await harness.init("test-ws", { adapter: "mock" });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("init writes workspace config", async () => {
    const config = await harness.config();
    assert.equal(config.version, 1);
    assert.equal(config.name, "test-ws");
    assert.equal(config.adapter, "mock");
  });

  it("spawn + send records turns with mock adapter", async () => {
    const session = await harness.spawn({
      name: "worker-a",
      role: "fast",
      prompt: "Implement feature X",
      run: true,
    });

    assert.equal(session.name, "worker-a");
    assert.equal(session.role, "fast");
    assert.equal(session.status, "idle");
    assert.ok(session.turns.length >= 3); // system + user + assistant
    const last = session.turns[session.turns.length - 1];
    assert.equal(last?.role, "assistant");
    assert.match(last?.content ?? "", /mock\/fast/);
    assert.match(last?.content ?? "", /worker-a/);
  });

  it("rejects duplicate session names", async () => {
    await harness.spawn({
      name: "dup",
      role: "good",
      prompt: "first",
      run: false,
    });
    await assert.rejects(
      () =>
        harness.spawn({
          name: "dup",
          role: "fast",
          prompt: "second",
          run: false,
        }),
      (err: unknown) => err instanceof StorageError,
    );
  });

  it("list and status report sessions", async () => {
    await harness.spawn({
      name: "alpha",
      role: "fast",
      prompt: "a",
      run: false,
    });
    await harness.spawn({
      name: "beta",
      role: "good",
      prompt: "b",
      run: false,
    });

    const listed = await harness.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.name),
      ["alpha", "beta"],
    );

    const overview = await harness.status();
    assert.equal(overview.config.name, "test-ws");
    assert.equal(overview.counts.idle, 2);
  });

  it("send appends follow-up turns", async () => {
    await harness.spawn({
      name: "chat",
      role: "good",
      prompt: "initial",
      run: true,
    });
    const after = await harness.send("chat", "follow up please");
    const users = after.turns.filter((t) => t.role === "user");
    assert.ok(users.length >= 2);
    assert.equal(after.status, "idle");
  });

  it("wait marks session waiting", async () => {
    await harness.spawn({
      name: "blocked",
      role: "fast",
      prompt: "wait me",
      run: false,
    });
    const waiting = await harness.wait("blocked", { markOnly: true });
    assert.equal(waiting.status, "waiting");
  });

  it("done sets status", async () => {
    await harness.spawn({
      name: "fin",
      role: "fast",
      prompt: "close",
      run: false,
    });
    const done = await harness.setStatus("fin", "done");
    assert.equal(done.status, "done");
  });

  it("check validates delivery contract criteria", async () => {
    const criteriaRel = "criteria/auth.txt";
    await mkdir(path.join(cwd, "criteria"), { recursive: true });
    await writeFile(
      path.join(cwd, criteriaRel),
      ["# auth delivery", 'command:["node","-e","process.exit(0)"]', "file:artifacts/ok.txt"].join("\n"),
      "utf8",
    );

    await harness.spawn({
      name: "auth",
      role: "good",
      prompt: "ship auth",
      criteriaFile: criteriaRel,
      run: false,
    });

    // Missing both criteria
    let results = await harness.check("auth");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false);
    assert.ok(results[0]?.missing.some((m) => m.startsWith("command:")));
    assert.ok(results[0]?.missing.some((m) => m.startsWith("file:")));

    // Satisfy text via send, still missing file
    await harness.send("auth", "report: tests pass on CI");
    results = await harness.check("auth", { runCommands: true });
    assert.equal(results[0]?.ok, false);
    assert.ok(results[0]?.missing.every((m) => m.startsWith("file:")));

    // Create required artifact
    await mkdir(path.join(cwd, "artifacts"), { recursive: true });
    await writeFile(path.join(cwd, "artifacts", "ok.txt"), "ok\n", "utf8");
    results = await harness.check("auth", { runCommands: true });
    assert.equal(results[0]?.ok, true);
    assert.deepEqual(results[0]?.missing, []);
  });

  it("rejects invalid session names", async () => {
    await assert.rejects(
      () =>
        harness.spawn({
          name: "../evil",
          role: "fast",
          prompt: "nope",
          run: false,
        }),
      (err: unknown) => err instanceof StorageError,
    );
  });
});
