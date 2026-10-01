import http from "node:http";
import { authoriseConnection, makeRateLimiter, makeTokenMatcher } from "./auth.js";
import { makeJobs } from "./jobs.js";
import { makeMysql, mysqlError } from "./mysql.js";
import { makePostgres, postgresError } from "./postgres.js";
import { tokenSource } from "./secrets.js";

const DEFAULT_MAX_BODY = 8 << 20;

/**
 * Build the gateway from a config object. Returns the http.Server (not yet listening) and a close().
 *
 * `deps` lets tests replace the database layers and the token source.
 */
export function createGateway(config, deps = {}) {
  const currentTokens =
    deps.currentTokens ||
    tokenSource(config.tokens || [], { ttlMs: (config.tokenRefreshSeconds ?? 60) * 1000 });
  const tokenMatches = makeTokenMatcher(currentTokens);
  const overLimit = makeRateLimiter({
    windowMs: (config.rateLimit?.windowSeconds ?? 60) * 1000,
    max: config.rateLimit?.maxRequests ?? 240,
  });
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const ipHeader = (config.clientIpHeader || "").toLowerCase();

  const postgres = config.postgres ? deps.postgres || makePostgres(config.postgres) : null;
  const mysql = config.mysql ? deps.mysql || makeMysql(config.mysql) : null;
  const jobs = config.jobs ? deps.jobs || makeJobs(config.jobs) : null;
  const log = deps.log || console;

  const server = http.createServer(async (req, res) => {
    const ip = (ipHeader && req.headers[ipHeader]) || req.socket.remoteAddress || "?";
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      const body = { ok: true };
      if (config.healthDetails) {
        body.databases = postgres ? Object.keys(config.postgres.databases || {}) : [];
        body.mysql = mysql ? Object.keys(config.mysql.databases || {}) : [];
        body.jobs = jobs ? jobs.names : [];
      }
      return send(res, 200, body);
    }
    if (config.rest && url.pathname.startsWith("/rest/v1/")) {
      return proxyToRest(req, res, url, config.rest, log);
    }
    const routes = { "/sql": postgres, "/mysql": mysql, "/job": jobs };
    if (req.method !== "POST" || !routes[url.pathname]) return send(res, 404, { message: "not found" });

    let body;
    try {
      body = await readBody(req, maxBody);
    } catch (err) {
      // An oversized body and a broken upload are different failures and are reported differently.
      if (err?.tooLarge) {
        send(res, 413, { message: "body too large" });
        res.on("finish", () => req.destroy());
        return;
      }
      log.warn(`[sqlgate] request stream failed from ${ip}: ${err?.message}`);
      return send(res, 400, { message: `request stream failed: ${err?.message || "unknown"}` });
    }

    if (overLimit(String(ip))) return send(res, 429, { message: "too many requests" });

    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return send(res, 400, { message: "body is not JSON" });
    }

    if (url.pathname === "/job") {
      if (!tokenMatches(String(req.headers["x-gateway-token"] || ""))) {
        log.warn(`[sqlgate] job refused from ${ip}: unauthorised`);
        return send(res, 401, { message: "unauthorised" });
      }
      const outcome = await jobs.start(String(parsed.job || ""));
      if (outcome.error) return send(res, 409, { message: outcome.error });
      if (outcome.failed) return send(res, 502, { message: outcome.failed });
      return send(res, 202, outcome);
    }

    if (url.pathname === "/mysql") {
      const auth = authoriseConnection(req.headers["sql-connection-string"], config.mysql.databases || {}, tokenMatches);
      if (auth.error) {
        log.warn(`[sqlgate] mysql refused from ${ip}: ${auth.error}`);
        return send(res, 401, { message: auth.error });
      }
      const t0 = Date.now();
      try {
        const out = await mysql.run(auth.db, auth.role, parsed);
        log.log(`[sqlgate] ${auth.db}/${auth.role} ${preview(parsed.sql)} -> ${out.rowCount} rows in ${Date.now() - t0}ms from ${ip}`);
        return send(res, 200, out);
      } catch (err) {
        log.error(`[sqlgate] ${auth.db}/${auth.role} error: ${err.message}`);
        return send(res, 400, mysqlError(err));
      }
    }

    const auth = authoriseConnection(req.headers["neon-connection-string"], config.postgres.databases || {}, tokenMatches);
    if (auth.error) {
      log.warn(`[sqlgate] refused from ${ip}: ${auth.error}`);
      return send(res, 401, { message: auth.error });
    }
    const arrayMode = String(req.headers["neon-array-mode"] || "").toLowerCase() === "true";
    const t0 = Date.now();
    try {
      const out = await postgres.run(auth.db, auth.role, parsed, arrayMode, {
        isolationLevel: req.headers["neon-batch-isolation-level"],
        readOnly: req.headers["neon-batch-read-only"],
        deferrable: req.headers["neon-batch-deferrable"],
      });
      const what = out.results ? `batch of ${out.results.length}` : `${preview(parsed.query)} -> ${out.rowCount} rows`;
      log.log(`[sqlgate] ${auth.db}/${auth.role} ${what} in ${Date.now() - t0}ms from ${ip}`);
      return send(res, 200, out);
    } catch (err) {
      log.error(`[sqlgate] ${auth.db}/${auth.role} error: ${err.message}`);
      return send(res, 400, postgresError(err));
    }
  });

  async function close() {
    await new Promise((r) => server.close(() => r()));
    await Promise.all([postgres?.close?.(), mysql?.close?.()]);
  }

  return { server, close };
}

function preview(sql) {
  return String(sql ?? "").slice(0, 120).replace(/\s+/g, " ");
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Read the whole body before answering. If a handler answers early and leaves the body unread, a
 * proxy that reuses the connection hands the leftover bytes to the next caller.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    let tooLarge = false;
    const chunks = [];
    const fail = () => {
      const e = new Error("body too large");
      e.tooLarge = true;
      reject(e);
    };
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        // Keep reading and discard the rest, so the client finishes its upload and can read the 413.
        // Answering while it is still sending makes it see a broken pipe instead. Past four times the
        // limit the upload is not worth waiting for, and the 413 goes out at once.
        tooLarge = true;
        chunks.length = 0;
        if (n > limit * 4) {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          fail();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => (tooLarge ? fail() : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** Forward /rest/v1/<rest> to a PostgREST server as /<rest>, so supabase-js clients work unchanged. */
function proxyToRest(req, res, url, rest, log) {
  const path = url.pathname.slice("/rest/v1".length) + (url.search || "");
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  const upstream = http.request(
    { host: rest.host || "127.0.0.1", port: rest.port, method: req.method, path, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    log.error(`[sqlgate] rest proxy error: ${err.message}`);
    if (!res.headersSent) send(res, 502, { message: "rest layer unreachable" });
  });
  req.pipe(upstream);
}
