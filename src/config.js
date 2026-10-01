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
  if (!Array.isArray(config.tokens) || !config.tokens.length) problems.push("tokens: at least one secret reference is required");
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
