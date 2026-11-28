import { readFileSync } from "node:fs";
import { validCommand } from "./jobs.js";

/** Read and check a config file. Problems are reported all together, before anything starts. */
export function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const problems = checkConfig(config);
  if (problems.length) throw new Error(`invalid config ${path}:\n  - ${problems.join("\n  - ")}`);
  return config;
}

export function checkConfig(config) {
  const problems = [];
  const list = (v) => v === undefined || (Array.isArray(v) && v.every((r) => r && typeof r === "object"));
  if (!list(config.tokens)) problems.push("tokens: a list of secret references");
  if (!list(config.jobTokens)) problems.push("jobTokens: a list of secret references");
  const scopedCount =
    ["postgres", "mysql"].reduce(
      (n, side) => n + Object.values(config[side]?.databases || {}).filter((d) => d?.tokens?.length).length,
      0,
    ) + Object.values(config.hooks || {}).filter((h) => h?.tokens?.length).length;
  if (!config.tokens?.length && !config.jobTokens?.length && !scopedCount) {
    problems.push("tokens: at least one secret reference is required (in tokens, jobTokens, a database's tokens or a hook's tokens)");
  }
  if (!config.postgres && !config.mysql && !config.jobs && !config.rest) {
    problems.push("nothing to serve: add postgres, mysql, jobs or rest");
  }
  for (const side of ["postgres", "mysql"]) {
    const dbs = config[side]?.databases;
    if (!config[side]) continue;
    if (!dbs || typeof dbs !== "object" || !Object.keys(dbs).length) {
      problems.push(`${side}.databases: list at least one database`);
      continue;
    }
    for (const [name, db] of Object.entries(dbs)) {
      if (!Array.isArray(db.roles) || !db.roles.length) problems.push(`${side}.databases.${name}.roles: list at least one role`);
      if (!list(db.tokens)) problems.push(`${side}.databases.${name}.tokens: a list of secret references`);
    }
  }
  if (config.rest && !config.rest.port) problems.push("rest.port is required");
  for (const [name, job] of Object.entries(config.jobs || {})) {
    if (job.url && job.command !== undefined) problems.push(`jobs.${name}: give a url or a command, not both`);
    else if (job.command !== undefined && !validCommand(job.command)) {
      problems.push(`jobs.${name}.command: a list of strings whose first item is an absolute path`);
    } else if (!job.url && job.command === undefined) problems.push(`jobs.${name}: a url or a command is required`);
  }
  for (const [name, hook] of Object.entries(config.hooks || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`hooks.${name}: a hook name is letters, digits, - and _ only`);
    if (!hook || !Object.prototype.hasOwnProperty.call(config.jobs || {}, hook.job)) {
      problems.push(`hooks.${name}.job: name one of the jobs`);
    }
    if (!Array.isArray(hook?.tokens) || !hook.tokens.length || !list(hook.tokens)) {
      problems.push(`hooks.${name}.tokens: a list of at least one secret reference, which opens this hook only`);
    }
  }
  const host = config.listen?.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !config.listen?.allowNonLoopback) {
    problems.push(`listen.host is ${host}; the gateway is meant to sit behind a tunnel on the loopback (set listen.allowNonLoopback to override)`);
  }
  return problems;
}
