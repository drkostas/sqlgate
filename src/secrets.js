import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Resolve a secret reference from the config file.
 *
 * A reference is one of:
 *   { "env": "NAME" }                       an environment variable
 *   { "file": "/path/to/file" }             the trimmed contents of a file
 *   { "command": ["prog", "arg", ...] }     the trimmed output of a command (a keychain, a vault CLI)
 *   { "value": "..." }                      a literal, for tests and local experiments only
 *
 * Add "optional": true to get an empty string instead of an error when the secret is missing.
 * The config file itself never needs to hold a real secret.
 */
export function resolveSecret(ref, { run = execFileSync, env = process.env, read = readFileSync } = {}) {
  if (ref == null) return "";
  if (typeof ref === "string") throw new Error("a secret must be a reference object, not a plain string");
  const optional = Boolean(ref.optional);
  try {
    let value;
    if ("env" in ref) value = env[ref.env];
    else if ("file" in ref) value = read(ref.file, "utf8");
    else if ("command" in ref) {
      const [prog, ...args] = ref.command;
      value = run(prog, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } else if ("value" in ref) value = ref.value;
    else throw new Error(`unknown secret reference: ${JSON.stringify(Object.keys(ref))}`);
    value = (value ?? "").toString().trim();
    if (!value && !optional) throw new Error("secret is empty");
    return value;
  } catch (err) {
    if (optional) return "";
    const where = ref.env ? `env ${ref.env}` : ref.file ? `file ${ref.file}` : ref.command ? `command ${ref.command[0]}` : "value";
    throw new Error(`could not read secret from ${where}: ${err.message}`);
  }
}

/**
 * The gateway tokens, re-read at most once per `ttlMs`.
 *
 * Two tokens can be valid at once so a token can be rotated without redeploying every client on the
 * same minute: put the new token in the first reference, the old one in the second, move clients over,
 * then clear the second. Reading is cached because a command reference spawns a process.
 */
export function tokenSource(refs, { ttlMs = 60_000, minLength = 24, resolve = resolveSecret, now = Date.now } = {}) {
  let cache = { at: -Infinity, values: [] };
  return function currentTokens() {
    const t = now();
    if (t - cache.at < ttlMs && cache.values.length) return cache.values;
    const values = [];
    for (const ref of refs) {
      let v = "";
      try {
        v = resolve(ref);
      } catch (err) {
        console.error(`[sqlgate] ${err.message}`);
      }
      if (v && v.length >= minLength) values.push(v);
      else if (v) console.error(`[sqlgate] ignoring a token shorter than ${minLength} characters`);
    }
    if (!values.length) console.error("[sqlgate] no usable token; every request will be refused");
    cache = { at: t, values };
    return values;
  };
}
