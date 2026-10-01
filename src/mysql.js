import { resolveSecret } from "./secrets.js";

/**
 * The MySQL side. Each request carries one statement and commits on its own: there is no session, so
 * two statements cannot be made atomic. The Python client in clients/python speaks this shape.
 */
export function makeMysql(config, { createPool } = {}) {
  const pools = new Map();

  async function poolFor(db, role) {
    const key = `${db}:${role}`;
    if (!pools.has(key)) {
      const make = createPool || (await import("mysql2/promise")).default.createPool;
      const ref = config.rolePasswords?.[role];
      pools.set(
        key,
        make({
          host: config.host || "127.0.0.1",
          port: config.port || 3306,
          user: role,
          password: ref ? resolveSecret(ref) : undefined,
          database: db,
          connectionLimit: config.poolSize || 8,
          // The wire carries text and the client parses it with the column type sent beside it, so a
          // date stays a date on the far side.
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
          multipleStatements: false,
        }),
      );
    }
    return pools.get(key);
  }

  async function run(db, role, { sql, params }) {
    const pool = await poolFor(db, role);
    const [result, fields] = await pool.query({
      sql: String(sql ?? ""),
      values: Array.isArray(params) ? params.map(fromJson) : [],
      // Rows as arrays, because a join can repeat a column name and the client rebuilds rows by position.
      rowsAsArray: true,
    });
    return shapeResult(result, fields);
  }

  async function close() {
    await Promise.all([...pools.values()].map((p) => p.end()));
    pools.clear();
  }

  return { run, close };
}

/** A write answers with an OK packet, a read with rows. Both come back in one shape. */
export function shapeResult(result, fields) {
  if (!Array.isArray(result)) {
    return { columns: [], rows: [], rowCount: result.affectedRows ?? 0, lastRowId: result.insertId ?? 0 };
  }
  return {
    columns: (fields || []).map((f) => ({ name: f.name, type: f.columnType })),
    rows: result.map((row) => row.map(jsonSafe)),
    rowCount: result.length,
    lastRowId: 0,
  };
}

/** JSON has no bytes, so a blob travels as {"$b64": ...} and the client can tell it from a string. */
export function jsonSafe(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { $b64: v.toString("base64") };
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** The reverse of jsonSafe for bound parameters, so bytes are stored as bytes and not as base64 text. */
export function fromJson(v) {
  if (v !== null && typeof v === "object" && typeof v.$b64 === "string") return Buffer.from(v.$b64, "base64");
  return v;
}

/** MySQL's own error number and SQLSTATE, so the client can raise the exception a local driver would. */
export function mysqlError(err) {
  return { message: err.message, errno: err.errno, sqlState: err.sqlState };
}
