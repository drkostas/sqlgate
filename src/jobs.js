import http from "node:http";
import { resolveSecret } from "./secrets.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Named local jobs that a hosted app may start.
 *
 * A job is a POST to an HTTP endpoint on this machine, listed by name in the config. The caller sends
 * a name, never a URL, and every URL must be on the loopback, so this can never become an open proxy.
 * Long work stays where its data is and runs without any serverless timeout over it.
 */
export function makeJobs(jobs = {}, { resolve = resolveSecret, answerMs = 3000 } = {}) {
  for (const [name, job] of Object.entries(jobs)) {
    const host = new URL(job.url).hostname;
    if (!LOOPBACK.has(host)) throw new Error(`job ${name}: url must be on the loopback, got ${host}`);
  }
  const running = new Set();

  /**
   * Start a job and report what the job's own server answered, not what was sent.
   *
   * The job's server should refuse with 409 when the job is already running. A job that runs in the
   * background answers 2xx at once. A job that runs inside the request answers nothing until it ends,
   * so silence after `answerMs` is reported as started.
   *
   * Resolves to { started }, { error } (already running or unknown), or { failed } (unreachable or broke).
   */
  function start(name) {
    const job = Object.prototype.hasOwnProperty.call(jobs, name) ? jobs[name] : null;
    if (!job) return Promise.resolve({ error: `no such job: ${name}` });
    if (running.has(name)) return Promise.resolve({ error: `already running: ${name}` });

    return new Promise((done) => {
      let answered = false;
      const answer = (v) => {
        if (!answered) {
          answered = true;
          done(v);
        }
      };
      const url = new URL(job.url);
      const headers = { "content-type": "application/json", "content-length": 2 };
      if (job.basicAuth) {
        const password = resolve(job.basicAuth.password);
        headers.authorization = `Basic ${Buffer.from(`${job.basicAuth.user}:${password}`).toString("base64")}`;
      }
      running.add(name);
      const request = http.request(
        { host: url.hostname, port: url.port || 80, method: "POST", path: url.pathname + url.search, headers },
        (response) => {
          const code = response.statusCode;
          if (code === 409) answer({ error: `already running: ${name}` });
          else if (code >= 200 && code < 300) answer({ started: name });
          // Keep a bounded part of the body, because this log line may be the only record of a failure.
          const chunks = [];
          response.on("data", (c) => {
            if (chunks.length < 64) chunks.push(c);
          });
          response.on("end", () => {
            running.delete(name);
            const ok = code >= 200 && code < 300;
            const detail = ok ? "" : ` ${Buffer.concat(chunks).toString("utf8").slice(0, 600).replace(/\s+/g, " ")}`;
            if (!ok && code !== 409) answer({ failed: `job server answered ${code}${detail}` });
            (ok ? console.log : console.error)(`[sqlgate] job ${name} finished with ${code}${detail}`);
          });
        },
      );
      request.on("error", (err) => {
        running.delete(name);
        console.error(`[sqlgate] job ${name} failed to start: ${err.message}`);
        answer({ failed: `could not reach the job server: ${err.message}` });
      });
      // No socket timeout: the job is meant to outlive this request. Only the answer is bounded.
      request.end("{}");
      setTimeout(() => answer({ started: name }), job.answerMs ?? answerMs).unref();
    });
  }

  return { start, names: Object.keys(jobs) };
}
