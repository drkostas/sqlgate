import crypto from "node:crypto";

/**
 * True when `given` equals one of the current tokens.
 *
 * timingSafeEqual throws on a length mismatch, so lengths are compared first. Every candidate is
 * checked, so a match on the previous token takes as long as a match on the current one.
 */
export function makeTokenMatcher(currentTokens) {
  return function tokenMatches(given) {
    const a = Buffer.from(String(given ?? ""));
    let ok = false;
    for (const candidate of currentTokens()) {
      const b = Buffer.from(candidate);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
    }
    return ok;
  };
}

/**
 * Check a connection string against the token and the served databases.
 *
 * The client keeps the connection string it would use for any hosted database. The password is the
 * gateway token, the path names the database and the user name picks the role. `databases` maps a
 * database name to the roles a caller may ask for. Anything not listed is refused.
 *
 * `scoped` maps a database name to a matcher for the tokens that open that database only (its
 * `tokens` in the config). A gateway token opens every database. A scoped token for another
 * database gets the same answer as a wrong token, so it cannot learn which databases are served.
 */
export function authoriseConnection(raw, databases, tokenMatches, scoped = {}) {
  if (!raw) return { error: "no connection string" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "unparseable connection string" };
  }
  const given = decodeURIComponent(url.password || "");
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const forDb = Object.prototype.hasOwnProperty.call(scoped, db) ? scoped[db] : null;
  if (!tokenMatches(given) && !(forDb && forDb(given))) return { error: "unauthorised" };
  if (!Object.prototype.hasOwnProperty.call(databases, db)) return { error: `database not served here: ${db}` };
  const role = decodeURIComponent(url.username || "");
  if (!databases[db].roles.includes(role)) return { error: `role not served for ${db}` };
  return { db, role };
}

/** A sliding-window rate limit per client address. */
export function makeRateLimiter({ windowMs = 60_000, max = 240, now = Date.now } = {}) {
  const hits = new Map();
  return function overLimit(ip) {
    const t = now();
    const seen = (hits.get(ip) || []).filter((x) => t - x < windowMs);
    seen.push(t);
    hits.set(ip, seen);
    if (hits.size > 5000) hits.clear();
    return seen.length > max;
  };
}
