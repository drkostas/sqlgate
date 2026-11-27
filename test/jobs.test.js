import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeJobs } from "../src/jobs.js";

// A real HTTP server stands in for the machine the job runs on, so these check what the gateway
// reports against what that server actually answered.
function jobServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const jobsOn = (port, answerMs = 300) =>
  makeJobs(
    { demo: { url: `http://127.0.0.1:${port}/demo`, basicAuth: { user: "u", password: { value: "pw" } } } },
    { answerMs },
  );

test("a 409 from the job server is reported as already running, not as started", async () => {
  const s = await jobServer((req, res) => {
    res.writeHead(409);
    res.end('{"message":"Already running."}');
  });
  const r = await jobsOn(s.address().port).start("demo");
  assert.match(r.error, /already running/i);
  s.close();
});

test("a quick 202 (a job that runs in the background) is started", async () => {
  const s = await jobServer((req, res) => {
    res.writeHead(202);
    res.end("{}");
  });
  assert.deepEqual(await jobsOn(s.address().port).start("demo"), { started: "demo" });
  s.close();
});

test("silence means the job is running, and the caller is not kept waiting", async () => {
  let hold;
  const s = await jobServer((req, res) => {
    hold = res;
  });
  const t0 = Date.now();
  assert.deepEqual(await jobsOn(s.address().port, 300).start("demo"), { started: "demo" });
  assert.ok(Date.now() - t0 < 2000);
  hold.writeHead(200);
  hold.end("done");
  s.close();
});

test("an unreachable job server is a failure, not a start", async () => {
  const s = await jobServer(() => {});
  const port = s.address().port;
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await jobsOn(port).start("demo")).failed);
});

test("a 500 is a failure that carries the server's reason", async () => {
  const s = await jobServer((req, res) => {
    res.writeHead(500);
    res.end("Traceback: boom");
  });
  const r = await jobsOn(s.address().port).start("demo");
  assert.match(r.failed, /500.*boom/);
  s.close();
});

test("the job server receives the configured basic auth", async () => {
  let seen;
  const s = await jobServer((req, res) => {
    seen = req.headers.authorization;
    res.writeHead(202);
    res.end("{}");
  });
  await jobsOn(s.address().port).start("demo");
  assert.equal(seen, `Basic ${Buffer.from("u:pw").toString("base64")}`);
  s.close();
});

test("an unknown job is refused before anything is sent", async () => {
  assert.match((await makeJobs({}).start("nope")).error, /no such job/);
});

test("a job url off the loopback is rejected at start-up", () => {
  assert.throws(() => makeJobs({ x: { url: "http://example.com/run" } }), /loopback/);
});

// Command jobs run this Node binary with a short script, so the tests need nothing installed.
const node = process.execPath;
const commandJob = (script, answerMs = 300) => makeJobs({ cmd: { command: [node, "-e", script] } }, { answerMs });

test("a command that exits 0 is started", async () => {
  assert.deepEqual(await commandJob("process.exit(0)").start("cmd"), { started: "cmd" });
});

test("a command that exits non-zero is a failure that carries its stderr", async () => {
  const r = await commandJob("console.error('unit not found'); process.exit(3)").start("cmd");
  assert.match(r.failed, /exit 3.*unit not found/);
});

test("a command still running after the answer time is reported as started, without waiting for it", async () => {
  const jobs = commandJob("setTimeout(() => {}, 1500)", 200);
  const t0 = Date.now();
  assert.deepEqual(await jobs.start("cmd"), { started: "cmd" });
  assert.ok(Date.now() - t0 < 1000);
  // and a second start while it runs is refused rather than run beside it
  assert.match((await jobs.start("cmd")).error, /already running/);
});

test("a command that cannot be run is a failure, not a start", async () => {
  const r = await makeJobs({ cmd: { command: ["/nonexistent/program"] } }).start("cmd");
  assert.match(r.failed, /could not run/);
});

test("a command is run without a shell, so its arguments reach it as written", async () => {
  // the script exits 0 only when it receives the text literally, with no substitution by a shell
  const script = "process.exit(process.argv[1] === '$(exit 9)' ? 0 : 4)";
  assert.deepEqual(await makeJobs({ cmd: { command: [node, "-e", script, "$(exit 9)"] } }).start("cmd"), { started: "cmd" });
});

test("a command whose program is not an absolute path is rejected at start-up", () => {
  assert.throws(() => makeJobs({ x: { command: ["launchctl", "kickstart", "x"] } }), /absolute path/);
  assert.throws(() => makeJobs({ x: { command: "/bin/true" } }), /absolute path/);
  assert.throws(() => makeJobs({ x: { command: [] } }), /absolute path/);
});
