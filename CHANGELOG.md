# Changelog

## Unreleased

## 0.4.1

- An empty gateway `tokens` list (a config that keeps only database and job tokens) no longer prints "no usable token" on every request

## 0.4.0

- The gateway serves from a worker under a main process that holds the port. `SIGHUP` starts a new worker with the config and code read again, and the old one finishes its requests before it exits, so a reload refuses no request. A config that does not load is refused and the running worker keeps serving
- `SIGTERM` and `SIGINT` let the requests in flight finish (`shutdownGraceSeconds`, 10 by default) before the process exits

- A `v<version>` tag attaches the `npm pack` tarball to a GitHub release of the tag, installable by URL. The same tarball goes to npm only when the repository variable `NPM_PUBLISH` is `true`

## 0.3.1

- Each request's log line ends with the kind of token that let it in (`gateway`, `database` or `job`), so a rotation can confirm an old token is no longer used before removing it

## 0.3.0

- A database can carry its own `tokens`, which open that database only, and `jobTokens` open `POST /job` only. A token for another database gets the same 401 as a wrong one. The gateway `tokens` still open everything, and a config may now hold only scoped tokens
- Requests to `/rest/v1/*` count against the rate limit like every other route (they went to PostgREST without it)
- The npm package is published from GitHub Actions with npm's trusted publishing when a `v<version>` tag is pushed, so no npm token is kept anywhere, and each release carries provenance

## 0.2.0

- A Claude Code skill for moving an app onto a self-hosted database through sqlgate, installed with `sqlgate skill`
- The connection and tunnel examples now use a name one level below the domain, which a free Cloudflare certificate covers

## 0.1.0

First release, published on npm as `@drkostas/sqlgate` (npm refuses the plain name as too close to `sqlite`).

- `POST /sql` for the Neon serverless driver, with array mode and `sql.transaction` batches as real transactions
- `POST /mysql` for the Python DB-API client in `clients/python`
- `/rest/v1/*` forwarded to PostgREST
- Named loopback jobs with `POST /job`
- Two tokens for rotation, constant time comparison, per address rate limit, statement log
- Config file with secret references (environment variable, file or command)
