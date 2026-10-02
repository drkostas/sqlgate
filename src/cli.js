#!/usr/bin/env node
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
if (!tokenSource(config.tokens)().length) {
  console.error("[sqlgate] refusing to start: no token of at least 24 characters could be read");
  process.exit(3);
}

const { server } = createGateway(config);
const host = config.listen?.host ?? "127.0.0.1";
const port = config.listen?.port ?? 8102;
server.listen(port, host, () => {
  const served = [
    config.postgres && `postgres ${Object.keys(config.postgres.databases).join(", ")}`,
    config.mysql && `mysql ${Object.keys(config.mysql.databases).join(", ")}`,
    config.jobs && `jobs ${Object.keys(config.jobs).join(", ")}`,
    config.rest && `rest on ${config.rest.port}`,
  ].filter(Boolean);
  console.log(`[sqlgate] listening on ${host}:${port} (${served.join("; ")})`);
});
