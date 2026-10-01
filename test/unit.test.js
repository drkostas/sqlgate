import { test } from "node:test";
import assert from "node:assert/strict";
import { authoriseConnection, makeRateLimiter, makeTokenMatcher } from "../src/auth.js";
import { checkConfig } from "../src/config.js";
import { fromJson, jsonSafe, shapeResult } from "../src/mysql.js";
import { resolveSecret, tokenSource } from "../src/secrets.js";
import { TOKEN } from "./helpers.js";

const matches = makeTokenMatcher(() => [TOKEN, "previous-token-0123456789ab"]);
const dbs = { app: { roles: ["app_rw", "app_ro"] } };

test("both the current and the previous token are accepted", () => {
  assert.ok(matches(TOKEN));
  assert.ok(matches("previous-token-0123456789ab"));
  assert.ok(!matches("wrong"));
  assert.ok(!matches(""));
});

test("a connection string picks the database and the role", () => {
  assert.deepEqual(authoriseConnection(`postgresql://app_ro:${TOKEN}@h/app`, dbs, matches), { db: "app", role: "app_ro" });
  assert.match(authoriseConnection(`postgresql://app_ro:bad@h/app`, dbs, matches).error, /unauthorised/);
  assert.match(authoriseConnection(`postgresql://app_ro:${TOKEN}@h/other`, dbs, matches).error, /not served/);
  assert.match(authoriseConnection(`postgresql://root:${TOKEN}@h/app`, dbs, matches).error, /role not served/);
  assert.match(authoriseConnection("not a url", dbs, matches).error, /unparseable/);
  assert.match(authoriseConnection(undefined, dbs, matches).error, /no connection string/);
});

test("a database name cannot reach inherited object keys", () => {
  assert.match(authoriseConnection(`postgresql://x:${TOKEN}@h/constructor`, dbs, matches).error, /not served/);
});

test("the rate limit counts per address within the window", () => {
  let t = 0;
  const over = makeRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.ok(!over("a"));
  assert.ok(!over("a"));
  assert.ok(over("a"));
  assert.ok(!over("b"));
  t = 1500;
  assert.ok(!over("a"));
});

test("secret references", () => {
  assert.equal(resolveSecret({ env: "X" }, { env: { X: " v " } }), "v");
  assert.equal(resolveSecret({ value: "lit" }), "lit");
  assert.equal(resolveSecret({ command: ["echo", "out"] }), "out");
  assert.equal(resolveSecret({ env: "MISSING", optional: true }, { env: {} }), "");
  assert.throws(() => resolveSecret({ env: "MISSING" }, { env: {} }), /could not read secret from env MISSING/);
  assert.throws(() => resolveSecret("plain"), /reference object/);
});

test("tokens are cached for the ttl and short tokens are ignored", () => {
  let t = 0;
  let reads = 0;
  const src = tokenSource([{ value: TOKEN }, { value: "short" }], {
    ttlMs: 1000,
    now: () => t,
    resolve: (r) => (reads++, r.value),
  });
  assert.deepEqual(src(), [TOKEN]);
  src();
  assert.equal(reads, 2);
  t = 2000;
  src();
  assert.equal(reads, 4);
});

test("config problems are listed together", () => {
  assert.deepEqual(checkConfig({ tokens: [{ env: "T" }], postgres: { databases: { a: { roles: ["r"] } } } }), []);
  const problems = checkConfig({ postgres: { databases: { a: {} } }, listen: { host: "0.0.0.0" } });
  assert.equal(problems.length, 3);
});

test("mysql results keep bytes and dates distinguishable", () => {
  const out = shapeResult([[1, Buffer.from("hi"), null]], [{ name: "a", columnType: 3 }, { name: "b", columnType: 252 }, { name: "c", columnType: 253 }]);
  assert.deepEqual(out.rows, [[1, { $b64: "aGk=" }, null]]);
  assert.deepEqual(out.columns.map((c) => c.type), [3, 252, 253]);
  assert.deepEqual(shapeResult({ affectedRows: 2, insertId: 7 }), { columns: [], rows: [], rowCount: 2, lastRowId: 7 });
  assert.deepEqual(fromJson({ $b64: "aGk=" }), Buffer.from("hi"));
  assert.equal(jsonSafe(new Date(0)), "1970-01-01T00:00:00.000Z");
});

test("BEGIN only carries known options", async () => {
  const { beginStatement } = await import("../src/postgres.js");
  assert.equal(beginStatement({}), "BEGIN");
  assert.equal(beginStatement({ isolationLevel: "RepeatableRead", readOnly: "true", deferrable: "true" }), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY DEFERRABLE");
  assert.equal(beginStatement({ isolationLevel: "x; drop table item" }), "BEGIN");
});

test("the example config is valid", async () => {
  const { loadConfig } = await import("../src/config.js");
  assert.ok(loadConfig(new URL("../examples/sqlgate.example.json", import.meta.url)));
});
