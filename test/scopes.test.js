import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { authoriseConnection, makeTokenMatcher } from "../src/auth.js";
import { checkConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

const GATEWAY = "gateway-token-0123456789abcdef";
const SHOP = "shop-only-token-0123456789abcd";
const JOB = "job-only-token-0123456789abcdef";

test("a scoped token opens its own database and no other", () => {
  const dbs = { shop: { roles: ["app"] }, blog: { roles: ["app"] } };
  const gateway = makeTokenMatcher(() => [GATEWAY]);
  const scoped = { shop: makeTokenMatcher(() => [SHOP]) };
  assert.deepEqual(authoriseConnection(`postgresql://app:${SHOP}@h/shop`, dbs, gateway, scoped), { db: "shop", role: "app", token: "database" });
  assert.match(authoriseConnection(`postgresql://app:${SHOP}@h/blog`, dbs, gateway, scoped).error, /^unauthorised$/);
  assert.deepEqual(authoriseConnection(`postgresql://app:${GATEWAY}@h/blog`, dbs, gateway, scoped), { db: "blog", role: "app", token: "gateway" });
});

test("a scoped token learns nothing about databases it does not open", () => {
  const dbs = { shop: { roles: ["app"] } };
  const scoped = { shop: makeTokenMatcher(() => [SHOP]) };
  const none = makeTokenMatcher(() => []);
  // the same answer as a wrong token, whether or not the database exists
  assert.equal(authoriseConnection(`postgresql://app:${SHOP}@h/missing`, dbs, none, scoped).error, "unauthorised");
  assert.equal(authoriseConnection(`postgresql://app:wrong@h/missing`, dbs, none, scoped).error, "unauthorised");
});

test("a config may hold only scoped tokens, but not none at all", () => {
  const shop = { roles: ["app"], tokens: [{ env: "SHOP" }] };
  assert.deepEqual(checkConfig({ postgres: { databases: { shop } } }), []);
  assert.deepEqual(checkConfig({ jobTokens: [{ env: "J" }], jobs: { a: { url: "http://x" } } }), []);
  assert.match(checkConfig({ postgres: { databases: { shop: { roles: ["app"] } } } }).join(), /at least one secret reference/);
  assert.match(checkConfig({ tokens: [{ env: "T" }], jobTokens: "J", jobs: { a: { url: "http://x" } } }).join(), /jobTokens/);
  assert.match(
    checkConfig({ tokens: [{ env: "T" }], postgres: { databases: { shop: { roles: ["app"], tokens: "S" } } } }).join(),
    /shop\.tokens/,
  );
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

test("through the gateway: database tokens, the job token and the gateway token", async () => {
  const ran = [];
  const logged = [];
  const { server, close } = createGateway(
    {
      tokens: [],
      postgres: { databases: { shop: { roles: ["app"], tokens: [{ value: SHOP }] }, blog: { roles: ["app"] } } },
      jobs: { rebuild: { url: "http://unused" } },
      jobTokens: [{ value: JOB }],
    },
    {
      currentTokens: () => [GATEWAY],
      postgres: { run: async (db) => (ran.push(db), { rowCount: 0, rows: [], fields: [] }), close: async () => {} },
      jobs: { names: ["rebuild"], start: async (name) => ({ started: name }) },
      log: { log: (line) => logged.push(line), warn() {}, error() {} },
    },
  );
  const port = await listen(server);
  const sql = (token, db) =>
    call(port, "/sql", { headers: { "neon-connection-string": `postgresql://app:${token}@h/${db}` }, body: '{"query":"select 1"}' });
  try {
    assert.equal((await sql(SHOP, "shop")).status, 200);
    assert.equal((await sql(SHOP, "blog")).status, 401);
    assert.equal((await sql(GATEWAY, "blog")).status, 200);
    assert.equal((await sql(JOB, "shop")).status, 401);
    assert.deepEqual(ran, ["shop", "blog"]);
    // each line says which kind of token let the request in, so a rotation can see an old token is unused
    assert.match(logged.find((l) => l.includes("shop/app")), /\(database token\)$/);
    assert.match(logged.find((l) => l.includes("blog/app")), /\(gateway token\)$/);
    const job = (token) => call(port, "/job", { headers: { "x-gateway-token": token }, body: '{"job":"rebuild"}' });
    assert.equal((await job(JOB)).status, 202);
    assert.equal((await job(SHOP)).status, 401);
    assert.equal((await job(GATEWAY)).status, 202);
    assert.deepEqual(logged.filter((l) => l.startsWith("[sqlgate] job")).map((l) => l.split(" (")[1]), ["job token)", "gateway token)"]);
  } finally {
    await close();
  }
});

test("REST requests count against the rate limit", async () => {
  const rest = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  const restPort = await listen(rest);
  const { server, close } = createGateway(
    { tokens: [{ value: GATEWAY }], rest: { port: restPort }, rateLimit: { windowSeconds: 60, maxRequests: 2 } },
    { currentTokens: () => [GATEWAY], log: { log() {}, warn() {}, error() {} } },
  );
  const port = await listen(server);
  try {
    const get = () => call(port, "/rest/v1/items", { method: "GET" });
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 429);
  } finally {
    await close();
    await new Promise((r) => rest.close(r));
  }
});

test("the first refusal of a burst is logged with the limit, and only the first", async () => {
  const rest = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  const restPort = await listen(rest);
  const warned = [];
  const { server, close } = createGateway(
    { tokens: [{ value: GATEWAY }], rest: { port: restPort }, rateLimit: { windowSeconds: 60, maxRequests: 1 } },
    { currentTokens: () => [GATEWAY], log: { log() {}, warn: (line) => warned.push(line), error() {} } },
  );
  const port = await listen(server);
  try {
    const get = () => call(port, "/rest/v1/items", { method: "GET" });
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 429);
    assert.equal((await get()).status, 429);
    const limits = warned.filter((l) => l.includes("rate limit reached"));
    assert.equal(limits.length, 1);
    assert.match(limits[0], /1 requests in 60 s/);
  } finally {
    await close();
    await new Promise((r) => rest.close(r));
  }
});
