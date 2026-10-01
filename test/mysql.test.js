import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/server.js";
import { freePort, startMysql, TOKEN } from "./helpers.js";

let my;
let gw;
let base;

before(async () => {
  my = await startMysql();
  if (!my && process.env.CI) throw new Error("no MySQL available on the CI runner");
  if (!my) return;
  const port = await freePort();
  gw = createGateway(
    {
      tokens: [{ value: TOKEN }],
      mysql: {
        host: my.host,
        port: my.port,
        databases: { app: { roles: ["app_rw", "app_ro"] } },
        rolePasswords: { app_rw: { value: "rw-pass" }, app_ro: { value: "ro-pass" } },
      },
    },
    { log: { log() {}, warn() {}, error() {} } },
  );
  await new Promise((r) => gw.server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await gw?.close();
  await my?.stop();
});

const run = (role, sql, params = [], token = TOKEN) =>
  fetch(`${base}/mysql`, {
    method: "POST",
    headers: { "sql-connection-string": `mysql://${role}:${token}@sqlgate/app`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("insert reports the new id, select returns typed text", async (t) => {
  if (!my) return t.skip("no MySQL installed");
  const ins = await run("app_rw", "insert into item (name, made, price, photo) values (?, ?, ?, ?)", ["a", "2026-01-02 03:04:05", "1.50", { $b64: "AP8=" }]);
  assert.equal(ins.status, 200);
  assert.equal(ins.body.rowCount, 1);
  assert.ok(ins.body.lastRowId > 0);
  const sel = await run("app_rw", "select name, made, price, photo from item where id = ?", [ins.body.lastRowId]);
  assert.deepEqual(sel.body.rows, [["a", "2026-01-02 03:04:05", "1.50", { $b64: "AP8=" }]]);
  assert.deepEqual(sel.body.columns.map((c) => c.name), ["name", "made", "price", "photo"]);
});

test("a duplicate key comes back with MySQL's errno", async (t) => {
  if (!my) return t.skip("no MySQL installed");
  await run("app_rw", "insert into item (name) values ('dup')");
  const again = await run("app_rw", "insert into item (name) values ('dup')");
  assert.equal(again.status, 400);
  assert.equal(again.body.errno, 1062);
});

test("the read-only role cannot write", async (t) => {
  if (!my) return t.skip("no MySQL installed");
  const r = await run("app_ro", "insert into item (name) values ('x')");
  assert.equal(r.status, 400);
  assert.equal(r.body.errno, 1142);
});

test("a wrong token or an unlisted role is refused", async (t) => {
  if (!my) return t.skip("no MySQL installed");
  assert.equal((await run("app_rw", "select 1", [], "wrong-token-0123456789abcdef")).status, 401);
  assert.equal((await run("root", "select 1")).status, 401);
});

test("two statements in one request are refused", async (t) => {
  if (!my) return t.skip("no MySQL installed");
  const r = await run("app_rw", "select 1; select 2");
  assert.equal(r.status, 400);
});
