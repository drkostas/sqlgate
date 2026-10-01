import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "test-token-0123456789abcdef";

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Find a Postgres bin directory: PATH first, then the usual Linux location used by CI runners. */
function postgresBin() {
  try {
    const initdb = execFileSync("which", ["initdb"], { encoding: "utf8" }).trim();
    if (initdb) return join(initdb, "..");
  } catch {}
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) if (existsSync(join(base, v, "bin", "initdb"))) return join(base, v, "bin");
  }
  return null;
}

/**
 * Start a throwaway Postgres cluster in a temp folder, on a free port, with a role per database.
 * Returns null when no Postgres binaries are installed, so the caller can skip.
 */
export async function startPostgres() {
  const bin = postgresBin();
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), "sqlgate-pg-"));
  const port = await freePort();
  execFileSync(join(bin, "initdb"), ["-D", dir, "-U", "owner", "--auth=trust", "-E", "UTF8", "--no-locale"], { stdio: "ignore" });
  const proc = spawn(join(bin, "postgres"), ["-D", dir, "-p", String(port), "-k", dir, "-h", "127.0.0.1"], { stdio: "ignore" });
  const psql = (db, sql) =>
    execFileSync(join(bin, "psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "owner", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAtc", sql], {
      encoding: "utf8",
    });
  for (let i = 0; i < 100; i++) {
    try {
      psql("postgres", "select 1");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  psql("postgres", "create database app");
  psql("app", "create role app_rw login; create role app_ro login;");
  psql("app", "create table item (id serial primary key, name text not null, made timestamptz default now(), data jsonb, photo bytea)");
  psql("app", "grant select, insert, update, delete on item to app_rw; grant usage on sequence item_id_seq to app_rw; grant select on item to app_ro;");
  return {
    port,
    psql,
    async stop() {
      proc.kill("SIGINT");
      await new Promise((r) => proc.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A MySQL server for the tests, with a database "app" and two roles.
 * Uses $SQLGATE_TEST_MYSQL_URL (a root connection string, as CI provides) when set, or starts a
 * throwaway mysqld in a temp folder when one is installed. Returns null when neither is possible.
 */
export async function startMysql() {
  const mysql = (await import("mysql2/promise")).default;
  let stop = async () => {};
  let rootUrl = process.env.SQLGATE_TEST_MYSQL_URL;
  if (!rootUrl) {
    let mysqld;
    try {
      mysqld = execFileSync("which", ["mysqld"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
    const dir = mkdtempSync(join(tmpdir(), "sqlgate-my-"));
    const port = await freePort();
    execFileSync(mysqld, ["--no-defaults", "--initialize-insecure", `--datadir=${join(dir, "data")}`], { stdio: "ignore" });
    const proc = spawn(
      mysqld,
      ["--no-defaults", `--datadir=${join(dir, "data")}`, `--port=${port}`, `--socket=${join(dir, "s.sock")}`, "--bind-address=127.0.0.1", "--mysqlx=OFF", "--skip-log-bin"],
      { stdio: "ignore" },
    );
    rootUrl = `mysql://root@127.0.0.1:${port}/`;
    stop = async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    };
  }
  const u = new URL(rootUrl);
  let root;
  for (let i = 0; i < 150 && !root; i++) {
    try {
      root = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!root) {
    await stop();
    throw new Error("mysql did not come up");
  }
  for (const sql of [
    "drop database if exists app",
    "create database app",
    "drop user if exists 'app_rw'@'%', 'app_ro'@'%'",
    "create user 'app_rw'@'%' identified by 'rw-pass', 'app_ro'@'%' identified by 'ro-pass'",
    "create table app.item (id int auto_increment primary key, name varchar(50) unique, made datetime, price decimal(8,2), photo blob)",
    "grant select, insert, update, delete on app.* to 'app_rw'@'%'",
    "grant select on app.* to 'app_ro'@'%'",
  ]) {
    await root.query(sql);
  }
  await root.end();
  return { host: u.hostname, port: Number(u.port || 3306), stop };
}
