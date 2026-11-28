import { spawn as nodeSpawn } from "node:child_process";
import http from "node:http";
import { isAbsolute } from "node:path";
import { resolveSecret } from "./secrets.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Named local jobs that a hosted app may start.
 *
 * A job is a POST to an HTTP endpoint on this machine, or a command run on it, listed by name in the
 * config. The caller sends a name, never a URL or a command line, every URL must be on the loopback
 * and every command is a fixed list of arguments run without a shell, so this can never become an
 * open proxy or run anything the config does not name. Long work stays where its data is and runs
 * without any serverless timeout over it.
 */
export function makeJobs(jobs = {}, { resolve = resolveSecret, answerMs = 3000, spawn = nodeSpawn } = {}) {
  for (const [name, job] of Object.entries(jobs)) {
    if (job.command !== undefined) {
      if (!validCommand(job.command)) {
        throw new Error(`job ${name}: command must be a list of strings whose first item is an absolute path`);
      }
      continue;
    }
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
    if (job.command) return startCommand(name, job);

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

  /**
   * Run a command job. Exit 0 is a start: the usual command asks a service manager to start a unit
   * and returns at once (`launchctl kickstart`, `systemctl start --no-block`), and the service manager
   * keeps one copy of it. Any other exit is a failure that carries the end of what it wrote to stderr.
   * A command still running after `answerMs` is reported as started and left to finish.
   */
  function startCommand(name, job) {
    return new Promise((done) => {
      let answered = false;
      const answer = (v) => {
        if (!answered) {
          answered = true;
          done(v);
        }
      };
      const [file, ...args] = job.command;
      running.add(name);
      let child;
      try {
        child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
      } catch (err) {
        running.delete(name);
        console.error(`[sqlgate] job ${name} failed to start: ${err.message}`);
        return answer({ failed: `could not run the job command: ${err.message}` });
      }
      // Keep a bounded part of stderr, because this log line may be the only record of a failure.
      const chunks = [];
      child.stderr?.on("data", (c) => {
        if (chunks.length < 64) chunks.push(c);
      });
      let notStarted = false;
      child.on("error", (err) => {
        notStarted = true;
        running.delete(name);
        console.error(`[sqlgate] job ${name} failed to start: ${err.message}`);
        answer({ failed: `could not run the job command: ${err.message}` });
      });
      child.on("close", (code, signal) => {
        running.delete(name);
        if (notStarted) return; // already reported by the error handler
        if (code === 0) {
          console.log(`[sqlgate] job ${name} finished with exit 0`);
          return answer({ started: name });
        }
        const how = code === null ? `signal ${signal}` : `exit ${code}`;
        const detail = Buffer.concat(chunks).toString("utf8").slice(-600).replace(/\s+/g, " ").trim();
        console.error(`[sqlgate] job ${name} finished with ${how}${detail ? ` ${detail}` : ""}`);
        answer({ failed: `job command ended with ${how}${detail ? ` ${detail}` : ""}` });
      });
      setTimeout(() => answer({ started: name }), job.answerMs ?? answerMs).unref();
    });
  }

  return { start, names: Object.keys(jobs) };
}

/** A command is a non-empty list of strings whose program is an absolute path, so no search path decides what runs. */
export function validCommand(command) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === "string" && part.length > 0) &&
    isAbsolute(command[0])
  );
}
