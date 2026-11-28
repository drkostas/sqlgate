import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./helpers.js";

const ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(ROOT, "src", "cli.js");

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

async function start(restPort, cli = CLI, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sqlgate-reload-"));
  const port = await freePort();
  const config = join(dir, "sqlgate.json");
  writeFileSync(config, JSON.stringify({
    listen: { port }, tokens: [{ value: "reload-token-0123456789abcdef" }], rest: { port: restPort },
    rateLimit: { windowSeconds: 60, maxRequests: 100000 }, shutdownGraceSeconds: 5, ...extra,
  }));
  const proc = spawn(process.execPath, [cli, "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
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
    assert.equal(gw.out().match(/reload refused/g).length, 1);
    assert.ok(!gw.out().includes("reload failed"), gw.out());
  } finally {
    gw.proc.kill("SIGTERM");
    await new Promise((r) => gw.proc.once("exit", r));
    rest.close();
    gw.done();
  }
});

test("a reload checks the config with the code on disk, so an upgrade and a new setting reload together", async () => {
  // A copy of the package, so the test can upgrade it while it runs. The version that starts refuses a
  // setting, and the version put on disk before the reload accepts it, as a release that adds a setting does.
  const pkg = mkdtempSync(join(tmpdir(), "sqlgate-upgrade-"));
  cpSync(join(ROOT, "src"), join(pkg, "src"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(pkg, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"));
  const configJs = join(pkg, "src", "config.js");
  const upgraded = readFileSync(configJs, "utf8");
  const before = upgraded.replace(
    "const problems = [];",
    'const problems = [];\n  if (config.addedLater !== undefined) problems.push("addedLater is not a setting in this version");',
  );
  assert.notEqual(before, upgraded);
  writeFileSync(configJs, before);

  const rest = await stub(() => 5);
  const gw = await start(rest.address().port, join(pkg, "src", "cli.js"));
  try {
    writeFileSync(configJs, upgraded);
    const cfgPath = gw.proc.spawnargs[gw.proc.spawnargs.indexOf("--config") + 1];
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, addedLater: true }));
    gw.proc.kill("SIGHUP");
    await gw.until("reloaded");
    assert.ok(!gw.out().includes("reload refused"), gw.out());
    assert.equal(await get(gw.port, "/rest/v1/items"), 200);
  } finally {
    gw.proc.kill("SIGTERM");
    await new Promise((r) => gw.proc.once("exit", r));
    rest.close();
    gw.done();
    rmSync(pkg, { recursive: true, force: true });
  }
});
