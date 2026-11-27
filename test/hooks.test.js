import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkConfig } from "../src/config.js";
import { bearer, makeHooks } from "../src/hooks.js";
import { createGateway } from "../src/server.js";

const GATEWAY = "gateway-token-0123456789abcdef";
const WORKOUT = "workout-hook-token-0123456789ab";
const FORM = "form-hook-token-0123456789abcde";
const JOB = "job-only-token-0123456789abcdef";

test("the token is read with or without a Bearer prefix", () => {
  assert.equal(bearer(`Bearer ${WORKOUT}`), WORKOUT);
  assert.equal(bearer(`bearer   ${WORKOUT}`), WORKOUT);
  assert.equal(bearer(WORKOUT), WORKOUT);
  assert.equal(bearer(undefined), "");
});

test("a hook's token opens that hook and no other", () => {
  const hooks = makeHooks(
    { workout: { job: "sync", tokens: [{ value: WORKOUT }] }, form: { job: "mail", tokens: [{ value: FORM }] } },
    { source: (refs) => () => refs.map((r) => r.value) },
  );
  assert.equal(hooks.authorise("workout", `Bearer ${WORKOUT}`), "sync");
  assert.equal(hooks.authorise("form", `Bearer ${WORKOUT}`), null);
  assert.equal(hooks.authorise("missing", `Bearer ${WORKOUT}`), null);
  assert.equal(hooks.authorise("workout", ""), null);
});

test("config: a hook names a job and carries its own tokens", () => {
  const jobs = { sync: { command: ["/usr/bin/true"] } };
  const ok = { jobs, hooks: { workout: { job: "sync", tokens: [{ env: "W" }] } } };
  assert.deepEqual(checkConfig(ok), []);
  assert.match(checkConfig({ jobs, hooks: { workout: { job: "other", tokens: [{ env: "W" }] } } }).join(), /hooks\.workout\.job/);
  assert.match(checkConfig({ tokens: [{ env: "T" }], jobs, hooks: { workout: { job: "sync" } } }).join(), /hooks\.workout\.tokens/);
  assert.match(checkConfig({ tokens: [{ env: "T" }], jobs, hooks: { "a/b": { job: "sync", tokens: [{ env: "W" }] } } }).join(), /hook name/);
});

test("config: a job is a url or a command, never both and never neither", () => {
  const t = { tokens: [{ env: "T" }] };
  assert.deepEqual(checkConfig({ ...t, jobs: { a: { command: ["/usr/bin/true", "x"] } } }), []);
  assert.match(checkConfig({ ...t, jobs: { a: { url: "http://127.0.0.1/x", command: ["/usr/bin/true"] } } }).join(), /not both/);
  assert.match(checkConfig({ ...t, jobs: { a: {} } }).join(), /url or a command/);
  assert.match(checkConfig({ ...t, jobs: { a: { command: ["true"] } } }).join(), /absolute path/);
});

function gateway(start) {
  const logged = [];
  const { server, close } = createGateway(
    {
      tokens: [],
      jobs: { sync: { command: ["/usr/bin/true"] } },
      jobTokens: [{ value: JOB }],
      hooks: { workout: { job: "sync", tokens: [{ value: WORKOUT }] }, form: { job: "sync", tokens: [{ value: FORM }] } },
      rateLimit: { windowSeconds: 60, maxRequests: 20 },
    },
    {
      currentTokens: () => [GATEWAY],
      jobs: { names: ["sync"], start },
      log: { log: (l) => logged.push(l), warn: (l) => logged.push(l), error: (l) => logged.push(l) },
    },
  );
  return { server, close, logged };
}

test("through the gateway: the right token starts the job, every other token is refused alike", async () => {
  const started = [];
  const { server, close, logged } = gateway(async (name) => (started.push(name), { started: name }));
  const port = await listen(server);
  const hook = (name, auth, body = '{"workoutId":"w-1"}') =>
    call(port, `/hooks/${name}`, { headers: auth === null ? {} : { authorization: auth }, body });
  try {
    const ok = await hook("workout", `Bearer ${WORKOUT}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { received: true, job: "sync", running: false });
    assert.equal((await hook("workout", WORKOUT)).status, 200);
    // a body that is not JSON is the sender's business and still accepted
    assert.equal((await hook("workout", `Bearer ${WORKOUT}`, "workoutId=w-2")).status, 200);
    for (const [name, auth] of [
      ["workout", "Bearer wrong-token-0123456789abcdefgh"],
      ["workout", `Bearer ${FORM}`],
      ["workout", `Bearer ${GATEWAY}`],
      ["workout", `Bearer ${JOB}`],
      ["workout", null],
      ["missing", `Bearer ${WORKOUT}`],
    ]) {
      const r = await hook(name, auth);
      assert.equal(r.status, 401, `${name} ${auth}`);
      assert.equal(r.body, '{"message":"unauthorised"}');
    }
    assert.deepEqual(started, ["sync", "sync", "sync"]);
    // a hook token opens no database and not POST /job
    assert.equal((await call(port, "/job", { headers: { "x-gateway-token": WORKOUT }, body: '{"job":"sync"}' })).status, 401);
    assert.equal((await call(port, "/hooks/workout", { method: "GET" })).status, 404);
    // the log names the hook and the size, never the body
    assert.ok(logged.some((l) => /hook workout from .* \(19 bytes\): started sync/.test(l)));
    assert.ok(!logged.some((l) => l.includes("w-1")));
  } finally {
    await close();
  }
});

test("through the gateway: a job already running is still a received delivery, a failed start is a 502", async () => {
  let outcome = { error: "already running: sync" };
  const { server, close } = gateway(async () => outcome);
  const port = await listen(server);
  const hook = () => call(port, "/hooks/workout", { headers: { authorization: `Bearer ${WORKOUT}` } });
  try {
    const running = await hook();
    assert.equal(running.status, 200);
    assert.deepEqual(JSON.parse(running.body), { received: true, job: "sync", running: true });
    outcome = { failed: "job command ended with exit 1 no such unit" };
    const failed = await hook();
    assert.equal(failed.status, 502);
    assert.match(failed.body, /no such unit/);
  } finally {
    await close();
  }
});

test("through the gateway: hooks count against the rate limit", async () => {
  const { server, close } = gateway(async (name) => ({ started: name }));
  const port = await listen(server);
  try {
    let last;
    for (let i = 0; i < 21; i++) last = await call(port, "/hooks/workout", { headers: { authorization: "Bearer nope" } });
    assert.equal(last.status, 429);
  } finally {
    await close();
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function call(port, path, { method = "POST", headers = {}, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : body);
  });
}
