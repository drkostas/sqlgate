#!/usr/bin/env node
import cluster from "node:cluster";
import { loadConfig } from "./config.js";
import { tokenSource } from "./secrets.js";
import { createGateway } from "./server.js";

const args = process.argv.slice(2);
if (args[0] === "skill") {
  // Copy the Claude Code skill that comes with sqlgate into a skills folder. Needs no config.
  const { copyFileSync, mkdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const d = args.indexOf("--dir");
  const root = d >= 0 ? args[d + 1].replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".claude", "skills");
  const dest = join(root, "sqlgate");
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md"), join(dest, "SKILL.md"));
  console.log(`installed ${join(dest, "SKILL.md")}`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: sqlgate [--config path]   (default: $SQLGATE_CONFIG or ./sqlgate.json)\n       sqlgate skill [--dir ~/.claude/skills]   install the Claude Code skill");
  process.exit(0);
}
const i = args.indexOf("--config");
const path = i >= 0 ? args[i + 1] : process.env.SQLGATE_CONFIG || "sqlgate.json";

let config;
try {
  config = loadConfig(path);
} catch (err) {
  console.error(`[sqlgate] ${err.message}`);
  process.exit(2);
}

// A gateway with no usable token would start, look healthy and refuse everything, so it does not start.
// Every place a token can be named counts: the gateway tokens, the job tokens and each database's own.
const allRefs = [
  ...(config.tokens || []),
  ...(config.jobTokens || []),
  ...["postgres", "mysql"].flatMap((side) => Object.values(config[side]?.databases || {}).flatMap((d) => d.tokens || [])),
];
if (!tokenSource(allRefs)().length) {
  console.error("[sqlgate] refusing to start: no token of at least 24 characters could be read");
  process.exit(3);
}

const host = config.listen?.host ?? "127.0.0.1";
const port = config.listen?.port ?? 8102;
// How long a worker that stops taking connections may finish the requests it has (a reload, a stop).
const graceMs = (config.shutdownGraceSeconds ?? 10) * 1000;

// ⭐ A RELOAD WITHOUT A GAP. The main process holds the port and runs the gateway in a worker. SIGHUP
// starts a new worker, which reads the config and the code from disk again, and once it listens the
// old worker stops taking connections, finishes the requests it has and exits, so no request is
// refused on the way (two processes cannot share a port on every platform, so a restart of the whole
// process always leaves a gap). SIGTERM and SIGINT drain the worker the same way and then exit.
// SQLGATE_NO_CLUSTER=1 runs the gateway in this process, with the same drain on SIGTERM.
if (cluster.isPrimary && process.env.SQLGATE_NO_CLUSTER !== "1") {
  let current = cluster.fork();
  let stopping = false;
  const drain = (worker) =>
    new Promise((resolve) => {
      if (worker.isDead()) return resolve();
      const timer = setTimeout(() => worker.kill("SIGKILL"), graceMs);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      worker.send("drain");
    });
  cluster.on("exit", (worker, code, signal) => {
    if (stopping || worker !== current) return;
    console.error(`[sqlgate] the worker exited (${signal || code}); starting another`);
    current = cluster.fork();
  });
  process.on("SIGHUP", () => {
    try {
      loadConfig(path);
    } catch (err) {
      console.error(`[sqlgate] reload refused, the running worker keeps serving: ${err.message}`);
      return;
    }
    const fresh = cluster.fork();
    const failed = (code, signal) =>
      console.error(`[sqlgate] reload failed, the new worker exited (${signal || code}); the old one keeps serving`);
    fresh.once("exit", failed);
    fresh.once("listening", () => {
      fresh.off("exit", failed);
      const old = current;
      current = fresh;
      drain(old).then(() => console.log("[sqlgate] reloaded"));
    });
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      stopping = true;
      Promise.all(Object.values(cluster.workers).map(drain)).then(() => process.exit(0));
    });
  }
} else {
  const { server, close } = createGateway(config);
  let draining = false;
  const finish = () => {
    if (draining) return;
    draining = true;
    // stop taking connections, let the requests in flight finish, then close the database pools
    server.close(() => close().finally(() => process.exit(0)));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), graceMs).unref();
  };
  process.on("message", (m) => m === "drain" && finish());
  process.on("disconnect", finish);   // the main process is gone: nobody will send drain
  if (!cluster.isWorker) for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, finish);
  else for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {});   // the main process decides
  server.listen(port, host, () => {
    const served = [
      config.postgres && `postgres ${Object.keys(config.postgres.databases).join(", ")}`,
      config.mysql && `mysql ${Object.keys(config.mysql.databases).join(", ")}`,
      config.jobs && `jobs ${Object.keys(config.jobs).join(", ")}`,
      config.rest && `rest on ${config.rest.port}`,
    ].filter(Boolean);
    console.log(`[sqlgate] listening on ${host}:${port} (${served.join("; ")})${cluster.isWorker ? ` in worker ${process.pid}` : ""}`);
  });
}
