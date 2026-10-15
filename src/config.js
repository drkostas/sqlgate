import { readFileSync } from "node:fs";

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
  const scopedCount = ["postgres", "mysql"].reduce(
    (n, side) => n + Object.values(config[side]?.databases || {}).filter((d) => d?.tokens?.length).length,
    0,
  );
  if (!config.tokens?.length && !config.jobTokens?.length && !scopedCount) {
    problems.push("tokens: at least one secret reference is required (in tokens, jobTokens or a database's tokens)");
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
    if (!job.url) problems.push(`jobs.${name}.url is required`);
  }
  const host = config.listen?.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !config.listen?.allowNonLoopback) {
    problems.push(`listen.host is ${host}; the gateway is meant to sit behind a tunnel on the loopback (set listen.allowNonLoopback to override)`);
  }
  return problems;
}
