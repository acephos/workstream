import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Harness } from "../harness.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import { createServer } from "node:http";

async function workspace(work: (cwd: string, h: Harness) => Promise<void>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "ws-reliability-"));
  try { const h = new Harness({ cwd }); await h.init("test"); await work(cwd, h); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

it("overlapping sends across instances preserve both turns and see prior history", async () => {
  await workspace(async (cwd, h) => {
    await h.spawn({ name: "worker", role: "good", prompt: "begin", run: false });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = { kind: "test", generate: async (r: import("../types.js").GenerateRequest) => {
      if (r.message === "slow") entered();
      await sleep(r.message === "slow" ? 60 : 1);
      if (r.message === "fast") assert.ok(r.history.some(t => t.content === "reply:slow"));
      return { content: `reply:${r.message}` };
    } };
    const a = new Harness({ cwd, adapter }); const b = new Harness({ cwd, adapter });
    const slow = a.send("worker", "slow");
    await started;
    await Promise.all([slow, b.send("worker", "fast")]);
    const turns = (await a.get("worker")).turns;
    assert.deepEqual(turns.slice(1).map(t => t.content), ["slow", "reply:slow", "fast", "reply:fast"]);
  });
});

it("failed send retains user/error and releases the lock for recovery", async () => {
  await workspace(async (cwd, h) => {
    await h.spawn({ name: "worker", role: "good", prompt: "begin", run: false });
    const bad = new Harness({ cwd, adapter: { kind: "test", generate: async () => { throw new Error("provider failed"); } } });
    await assert.rejects(bad.send("worker", "attempt"), /provider failed/);
    const failed = await h.get("worker"); assert.equal(failed.status, "failed"); assert.equal(failed.turns.at(-1)?.content, "attempt");
    await h.send("worker", "retry"); assert.equal((await h.get("worker")).status, "idle");
  });
});

it("duplicate spawns race without replacing the winner", async () => {
  await workspace(async (cwd, h) => {
    const other = new Harness({ cwd });
    const results = await Promise.allSettled([h.spawn({name:"same", role:"fast", prompt:"one",run:false}),other.spawn({name:"same",role:"good",prompt:"two",run:false})]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal((await h.get("same")).turns.length,1);
  });
});

it("missing, empty, transcript-only, and nonzero command evidence fail closed", async () => {
  await workspace(async (cwd, h) => {
    await h.spawn({ name: "worker", role: "good", prompt: "tests pass", run: false });
    assert.equal((await h.check("worker"))[0]?.ok,false);
    await writeFile(path.join(cwd,"criteria.txt"),"text:tests pass\n");
    await h.spawn({name:"checked",role:"good",prompt:"tests pass",criteriaFile:"criteria.txt",run:false});
    assert.equal((await h.check("checked"))[0]?.ok,false);
    await writeFile(path.join(cwd,"criteria.txt"),"# empty\n"); assert.equal((await h.check("checked"))[0]?.ok,false);
    await writeFile(path.join(cwd,"criteria.txt"),'command:["node","-e","process.exit(1)"]\n');
    assert.equal((await h.check("checked",{runCommands:true}))[0]?.ok,false);
    assert.equal((await readdir(path.join(cwd,".workstream/evidence"))).length,1);
  });
});

it("checks record successful host evidence and reject timed-out checks", async () => {
  await workspace(async (cwd,h) => {
    await writeFile(path.join(cwd,"criteria.txt"),'command:["node","-e","process.exit(0)"]\n');
    await h.spawn({name:"checked",role:"good",prompt:"begin",criteriaFile:"criteria.txt",run:false});
    assert.equal((await h.check("checked"))[0]?.ok,false);
    assert.equal((await h.check("checked",{runCommands:true}))[0]?.ok,true);
    await writeFile(path.join(cwd,"criteria.txt"),'command:["node","-e","setInterval(()=>{},1000)"]\n');
    assert.equal((await h.check("checked",{runCommands:true,timeoutMs:50}))[0]?.ok,false);
  });
});

it("corrupt sessions surface an actionable error", async () => {
  await workspace(async(cwd,h) => {
    await writeFile(path.join(cwd,".workstream/sessions/broken.json"),"{");
    await assert.rejects(h.list(),/Cannot read session broken/);
  });
});

it("live HTTP adapter times out and supports caller cancellation", async () => {
  const server=createServer((_req,_res)=>{}); const sockets=new Set<import("node:net").Socket>();
  server.on("connection",s=>{sockets.add(s);s.on("close",()=>sockets.delete(s));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const port=(server.address() as import("node:net").AddressInfo).port;
    await workspace(async(cwd,h)=>{
      await h.spawn({name:"worker",role:"good",prompt:"begin",run:false});
      const a=new Harness({cwd,adapter:new OpenAIAdapter({apiKey:"test",baseUrl:`http://127.0.0.1:${port}`,timeoutMs:50})});
      await assert.rejects(a.send("worker","timeout"));assert.equal((await a.get("worker")).status,"failed");
      const controller=new AbortController();controller.abort();await assert.rejects(a.send("worker","cancelled",{signal:controller.signal}));
    });
  } finally {for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
