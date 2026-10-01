import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon, neonConfig } from "@neondatabase/serverless";
import { createGateway } from "../src/server.js";
import { freePort, startPostgres, TOKEN } from "./helpers.js";

let pg;
let gw;
let base;

before(async () => {
  pg = await startPostgres();
  // CI must really run these, so a missing Postgres there is a failure and not a skip.
  if (!pg && process.env.CI) throw new Error("no Postgres binaries found on the CI runner");
  if (!pg) return;
  const port = await freePort();
  gw = createGateway(
    {
      tokens: [{ value: TOKEN }],
      postgres: { host: "127.0.0.1", port: pg.port, databases: { app: { roles: ["app_rw", "app_ro"] } } },
    },
    { log: { log() {}, warn() {}, error() {} } },
  );
  await new Promise((r) => gw.server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
  // Point the real Neon driver at the gateway. Nothing else about the app changes.
  neonConfig.fetchEndpoint = () => `${base}/sql`;
});

after(async () => {
  await gw?.close();
  await pg?.stop();
});

const url = (role, token = TOKEN, db = "app") => `postgresql://${role}:${token}@db.example.com/${db}`;

test("the Neon driver reads and writes through the gateway", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  const [row] = await sql`insert into item (name, data) values (${"first"}, ${JSON.stringify({ a: 1 })}) returning id, name, made, data`;
  assert.equal(row.name, "first");
  assert.ok(row.made instanceof Date, "timestamps arrive as Date, parsed by the driver from raw text");
  assert.deepEqual(row.data, { a: 1 });
  const rows = await sql`select name from item where id = ${row.id}`;
  assert.deepEqual(rows, [{ name: "first" }]);
});

test("a batch runs in order and answers in order", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  const [a, b] = await sql.transaction([sql`select 1 as one`, sql`select 2 as two`]);
  assert.deepEqual(a, [{ one: 1 }]);
  assert.deepEqual(b, [{ two: 2 }]);
});

test("bytes round-trip as bytea", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const [row] = await sql`insert into item (name, photo) values ('pic', ${bytes}) returning photo`;
  assert.deepEqual(Buffer.from(row.photo), bytes);
});

test("a read-only role cannot write", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_ro"));
  await assert.rejects(sql`insert into item (name) values ('nope')`, /permission denied/);
});

test("database errors come back as database errors, with the code", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  await assert.rejects(sql`select * from missing_table`, (err) => err.code === "42P01");
});

for (const [name, conn, want] of [
  ["wrong token", url("app_rw", "wrong-token-0123456789abcdef"), /unauthorised/],
  ["unlisted database", url("app_rw", TOKEN, "postgres"), /not served/],
  ["unlisted role", url("owner"), /role not served/],
]) {
  test(`refused: ${name}`, async (t) => {
    if (!pg) return t.skip("no Postgres installed");
    const res = await fetch(`${base}/sql`, {
      method: "POST",
      headers: { "neon-connection-string": conn, "content-type": "application/json" },
      body: JSON.stringify({ query: "select 1", params: [] }),
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).message, want);
  });
}

test("an oversized body gets a 413, not a reset", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const big = JSON.stringify({ query: "select 1", params: ["x".repeat(9 << 20)] });
  const res = await fetch(`${base}/sql`, {
    method: "POST",
    headers: { "neon-connection-string": url("app_rw"), "content-type": "application/json" },
    body: big,
  });
  assert.equal(res.status, 413);
});

test("a batch is one transaction: a failing statement rolls back the earlier ones", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  await assert.rejects(sql.transaction([sql`insert into item (name) values ('rolled back')`, sql`select * from missing_table`]));
  const rows = await sql`select count(*)::int as n from item where name = 'rolled back'`;
  assert.deepEqual(rows, [{ n: 0 }]);
});

test("a read-only batch cannot write", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  await assert.rejects(sql.transaction([sql`insert into item (name) values ('ro')`], { readOnly: true }), /read-only transaction/);
});

test("the isolation level from the driver reaches Postgres", async (t) => {
  if (!pg) return t.skip("no Postgres installed");
  const sql = neon(url("app_rw"));
  const [[row]] = await sql.transaction([sql`show transaction_isolation`], { isolationLevel: "Serializable" });
  assert.equal(row.transaction_isolation, "serializable");
});
