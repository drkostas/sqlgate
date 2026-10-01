import pg from "pg";
import { resolveSecret } from "./secrets.js";

// Every value goes back as the text Postgres produced. The Neon driver parses it on the client using
// the field's dataTypeID, so converting anything here (a Date, a bigint) would corrupt it there.
const rawText = { getTypeParser: () => (v) => v };

/** One pool per database and role, created on first use. */
export function makePostgres(config) {
  const pools = new Map();
  const host = config.host || "127.0.0.1";
  const port = config.port || 5432;

  function poolFor(db, role) {
    const key = `${db}:${role}`;
    if (!pools.has(key)) {
      const ref = config.rolePasswords?.[role];
      const pool = new pg.Pool({
        host,
        port,
        database: db,
        user: role,
        password: ref ? resolveSecret(ref) : undefined,
        max: config.poolSize || 8,
      });
      // An idle client emits "error" when the server restarts. Without a listener that error ends
      // the whole process, so log it and let the pool drop the client.
      pool.on("error", (err) => console.error(`[sqlgate] idle client error on ${key}: ${err.message}`));
      pools.set(key, pool);
    }
    return pools.get(key);
  }

  async function runOne(pool, { query, params }, arrayMode) {
    const res = await pool.query({
      text: String(query ?? ""),
      values: Array.isArray(params) ? params : [],
      // The Neon driver always asks for array mode and rebuilds objects itself. A plain HTTP client
      // that wants rows gets rows, so the request header decides.
      ...(arrayMode ? { rowMode: "array" } : {}),
      types: rawText,
    });
    return {
      command: res.command,
      rowCount: res.rowCount,
      rows: res.rows,
      fields: (res.fields || []).map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        tableID: f.tableID,
        columnID: f.columnID,
        dataTypeSize: f.dataTypeSize,
        dataTypeModifier: f.dataTypeModifier,
        format: f.format,
      })),
      rowAsArray: Boolean(arrayMode),
    };
  }

  /**
   * Run one statement, or a batch as one transaction, for an authorised database and role.
   *
   * The Neon driver's sql.transaction() promises a single transaction, so a batch runs on one
   * connection between BEGIN and COMMIT, and any error rolls the whole batch back.
   */
  async function run(db, role, body, arrayMode, batch = {}) {
    const pool = poolFor(db, role);
    if (!Array.isArray(body.queries)) return runOne(pool, body, arrayMode);
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(beginStatement(batch));
      const results = [];
      for (const q of body.queries) results.push(await runOne(client, q, arrayMode));
      await client.query("COMMIT");
      return { results };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async function close() {
    await Promise.all([...pools.values()].map((p) => p.end()));
    pools.clear();
  }

  return { run, close };
}

const ISOLATION = {
  readuncommitted: "READ UNCOMMITTED",
  readcommitted: "READ COMMITTED",
  repeatableread: "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

/**
 * BEGIN with the options the Neon driver sends as headers. Only known values are used, so nothing
 * from a header reaches the SQL text.
 */
export function beginStatement({ isolationLevel, readOnly, deferrable } = {}) {
  const parts = ["BEGIN"];
  const level = ISOLATION[String(isolationLevel || "").replace(/[\s_-]/g, "").toLowerCase()];
  if (level) parts.push(`ISOLATION LEVEL ${level}`);
  if (String(readOnly).toLowerCase() === "true") parts.push("READ ONLY");
  if (String(deferrable).toLowerCase() === "true") parts.push("DEFERRABLE");
  return parts.join(" ");
}

/** The error fields the Neon driver reads, so an app sees a database error and not a transport one. */
export function postgresError(err) {
  return {
    message: err.message,
    code: err.code,
    severity: err.severity,
    detail: err.detail,
    hint: err.hint,
    position: err.position,
  };
}
