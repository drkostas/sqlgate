import { makeTokenMatcher } from "./auth.js";
import { tokenSource } from "./secrets.js";

/**
 * Named inbound webhooks, each of which starts one job.
 *
 * A service that sends webhooks (a fitness app on every saved workout, a form, a store) is given the
 * address `POST /hooks/<name>` and a token, which it sends in the Authorization header, with or
 * without the `Bearer ` prefix. A hook's tokens open that hook only: they open no database, no other
 * hook and not `POST /job`, and the gateway tokens do not open a hook, because a webhook token is
 * kept by another service. A wrong token, a token for another hook and an unknown hook all get the
 * same answer, so the refusal does not tell a caller which hooks exist (`healthDetails` lists them
 * on /healthz when it is turned on).
 */
export function makeHooks(hooks = {}, { ttlMs = 60_000, source = tokenSource } = {}) {
  const matchers = Object.fromEntries(
    Object.entries(hooks).map(([name, hook]) => [name, makeTokenMatcher(source(hook.tokens || [], { ttlMs }))]),
  );

  /** The job to start for this hook and Authorization header, or null when the caller is not let in. */
  function authorise(name, authorization) {
    const matches = Object.prototype.hasOwnProperty.call(matchers, name) ? matchers[name] : null;
    const given = bearer(authorization);
    if (!matches || !given || !matches(given)) return null;
    return hooks[name].job;
  }

  return { authorise, names: Object.keys(hooks) };
}

/** The token in an Authorization header, with an optional `Bearer ` prefix taken off. */
export function bearer(authorization) {
  const value = String(authorization ?? "").trim();
  const m = /^bearer\s+(.+)$/i.exec(value);
  return (m ? m[1] : value).trim();
}
