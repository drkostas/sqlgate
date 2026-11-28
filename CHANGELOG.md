# Changelog

## Unreleased

- The README now says what the same-401 refusal hides and what it does not: it does not tell a caller which databases or hooks exist, and `/healthz` still lists them when `healthDetails` is on
- The README says that a hook's tokens rotate the same way as the gateway tokens, with no refused delivery on the way

## 0.5.0

- Webhooks: `POST /hooks/<name>` starts the hook's job when another service sends an event, so the work runs as soon as it happens instead of on the next scheduled run. Each hook has its own tokens, read from the `Authorization` header with or without `Bearer `, which open that hook only. The body is never parsed or logged. A delivery is answered 200 when the job starts or is already running, and 502 when it cannot start, so the sender retries
- A job can be a `command` instead of a `url`: a fixed list of arguments whose program is an absolute path, run without a shell. Exit 0 is a start and any other exit is a failure with the end of its stderr, which suits a command that asks a service manager to start a unit and returns

## 0.4.2

- A request refused by the rate limit no longer counts against the window, so a client that keeps retrying while it is over the limit is admitted again as soon as its older requests leave the window (before, each refused retry kept it locked out)
- The first refusal of each burst is logged with the address and the limit (`rate limit reached for <address>`), so a client that only sees its own error can be matched to the gateway's side

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
