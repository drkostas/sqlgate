import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./helpers.js";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

function stub(delayMs) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => setTimeout(() => res.end("[]"), delayMs()));
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function get(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", (e) => resolve(e.code));
  });
}

async function start(restPort) {
  const dir = mkdtempSync(join(tmpdir(), "sqlgate-reload-"));
  const port = await freePort();
  const config = join(dir, "sqlgate.json");
  writeFileSync(config, JSON.stringify({
    listen: { port }, tokens: [{ value: "reload-token-0123456789abcdef" }], rest: { port: restPort },
    rateLimit: { windowSeconds: 60, maxRequests: 100000 }, shutdownGraceSeconds: 5,
  }));
  const proc = spawn(process.execPath, [CLI, "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const until = async (text, ms = 8000) => {
    const t0 = Date.now();
    while (!out.includes(text)) {
      if (Date.now() - t0 > ms) throw new Error(`no "${text}" in: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until("listening on");
  return { proc, port, until, out: () => out, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a reload on SIGHUP refuses no request", async () => {
  const rest = await stub(() => 20);
  const gw = await start(rest.address().port);
  try {
    const results = [];
    const loop = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) results.push(await get(gw.port, "/rest/v1/items"));
    })();
    await new Promise((r) => setTimeout(r, 600));
    gw.proc.kill("SIGHUP");
    await loop;
    await gw.until("reloaded");
    assert.ok(results.length > 20, `requests made: ${results.length}`);
    assert.deepEqual([...new Set(results)], [200]);
    assert.equal(gw.out().match(/listening on/g).length, 2);
    assert.equal(gw.proc.exitCode, null);
  } finally {
    gw.proc.kill("SIGTERM");
    await new Promise((r) => gw.proc.once("exit", r));
    rest.close();
    gw.done();
  }
});

test("SIGTERM lets the request in flight finish, then exits", async () => {
  const rest = await stub(() => 1200);
  const gw = await start(rest.address().port);
  try {
    const slow = get(gw.port, "/rest/v1/slow");
    await new Promise((r) => setTimeout(r, 300));
    const exited = new Promise((r) => gw.proc.once("exit", (code) => r(code)));
    gw.proc.kill("SIGTERM");
    assert.equal(await slow, 200);
    assert.equal(await exited, 0);
  } finally {
    rest.close();
    gw.done();
  }
});

test("a reload with a broken config is refused and the gateway keeps serving", async () => {
  const rest = await stub(() => 5);
  const gw = await start(rest.address().port);
  try {
    const cfgPath = gw.proc.spawnargs[gw.proc.spawnargs.indexOf("--config") + 1];
    writeFileSync(cfgPath, "{ not json");
    gw.proc.kill("SIGHUP");
    await gw.until("reload refused");
    assert.equal(await get(gw.port, "/rest/v1/items"), 200);
  } finally {
    gw.proc.kill("SIGTERM");
    await new Promise((r) => gw.proc.once("exit", r));
    rest.close();
    gw.done();
  }
});
