---
name: sqlgate
description: Use when moving an app from a hosted Postgres such as Neon (or a MySQL app) onto a database you run yourself, through the sqlgate server, and keeping it working. Covers the config file, connection strings for the Neon serverless driver and the Python MySQL client, the tunnel and token, proving results are identical before a switch, transactions and batches, body limits and 413, swapping a live gateway with a rollback, launchd and systemd, backups, and a failure catalogue.
---

# sqlgate

sqlgate answers `POST /sql` in the HTTP format the Neon serverless driver (`@neondatabase/serverless`) already sends. The driver is not a Postgres client. It posts each statement to an HTTPS endpoint. So an app written for Neon reaches a database on your own machine with a new connection string and no code change. sqlgate also answers `POST /mysql` for the Python client `sqlgate-client`, forwards `/rest/v1/*` to PostgREST, and starts named local jobs with `POST /job`.

Read `README.md` and `SECURITY.md` in the package before you publish a gateway. Anyone with the token can run every statement the named role allows.

## Decide first whether the app should move

- Whose project it is decides the database. A project that belongs to someone else stays on their own services.
- A public demo or a project other people fork should keep the hosted service (Neon, Supabase) as the documented default. Self-hosting is an alternative you run, never a replacement you force on forkers. Keep their env samples, scheduled workflows and setup steps working.
- Only an app that talks HTTP can use sqlgate. The Neon driver's HTTP mode (`neon()`, Drizzle `neon-http`) works. Socket drivers (`pg` Pool, `postgres.js`, `psycopg`, Neon's WebSocket `Pool` and `Client`) cannot reach it.
- The website stays on its host (Vercel and similar). Only the database and long jobs live on your machine.

## Install and configure

```bash
npm install -g @drkostas/sqlgate        # Node 20 or newer
cp "$(npm root -g)/@drkostas/sqlgate/examples/sqlgate.example.json" sqlgate.json
export SQLGATE_TOKEN="$(openssl rand -hex 32)"
sqlgate --config sqlgate.json           # or set SQLGATE_CONFIG
curl -s http://127.0.0.1:8102/healthz   # {"ok":true}
```

Every config key is in `examples/sqlgate.example.json`.

| Key | Default | Notes |
|---|---|---|
| `listen.host`, `listen.port` | `127.0.0.1`, `8102` | non-loopback refused unless `listen.allowNonLoopback` |
| `tokens` | required | secret references, first is current, second is previous |
| `tokenRefreshSeconds` | `60` | tokens are read again this often |
| `clientIpHeader` | none | `cf-connecting-ip` behind Cloudflare |
| `rateLimit.windowSeconds`, `rateLimit.maxRequests` | `60`, `240` | per client address |
| `maxBodyBytes` | `8388608` | larger bodies get 413 |
| `healthDetails` | `false` | true makes `/healthz` list databases and jobs |
| `postgres`, `mysql` | none | `host`, `port`, `poolSize` (8), `databases.<db>.roles`, `rolePasswords` |
| `rest` | none | `port`, optional `host`, of a PostgREST server |
| `jobs.<name>` | none | loopback `url`, optional `basicAuth`, optional `answerMs` |

A secret is always a reference object, never a plain string. The forms are `{"env": "NAME"}`, `{"file": "/path"}`, `{"command": ["prog", "arg"]}` (a keychain or vault CLI) and `{"value": "..."}` for tests. Add `"optional": true` to get an empty value instead of an error.

The process refuses to start with exit code 2 when the config is invalid (all problems are listed together) and exit code 3 when no token of at least 24 characters can be read. A shorter token is ignored with a log line.

## Roles

1. Create one role per app and per access level, for example `shop_app` (reads and writes its tables) and `shop_ro` (SELECT only). Never list the database owner or a superuser.
2. List each role under its database in `postgres.databases`. The username in the connection string picks the role, and an unlisted name is refused before any connection opens.
3. Grant each role nothing on other databases. Test it with a write as the reader, which must fail with code `42501`.
4. Know what the roles protect. With `trust` authentication on loopback they are not a boundary against processes on the same machine. They divide the callers that come in through the gateway.

## Connect an app

Postgres with the Neon driver uses the role as user and the token as password.

```
postgresql://shop_app:<token>@pg.example.com/shop
```

The driver replaces the first label of the host with `api` and posts to `https://api.example.com/sql`. Only `api.example.com` has to exist in DNS and in the tunnel. Pointed at `127.0.0.1` the driver builds `https://api.0.0.1/sql`, which is why a local URL never works with it. To name the endpoint yourself, set `neonConfig.fetchEndpoint` (a string or a function) before calling `neon()`.

Keep the gateway hostname one label below your domain. Cloudflare's free certificate covers `*.example.com` and not `*.db.example.com`, so `pg.db.example.com` leads to `api.db.example.com` and a failed TLS handshake unless you buy a certificate for it or use `fetchEndpoint`.

When the app picks its driver from the connection string, make the gateway host select the HTTP driver too. A rule that only knows `neon.tech` hosts sends the gateway host to a socket pool, and the build fails with `ENOTFOUND`.

MySQL from Python goes through the client, passed to SQLAlchemy as the DB-API module.

```python
import sqlalchemy as sa, sqlgate_client
engine = sa.create_engine("mysql+pymysql://blog_app:<token>@db.example.com/blog", module=sqlgate_client)
```

It posts to `https://<host>/mysql` (`http` for a loopback host). `SQLGATE_TIMEOUT` (default 20 s) and `SQLGATE_HOST` are read from the environment. The client sends its own user agent, because Cloudflare refuses Python's default one with a 403 (error 1010) that looks like an auth failure.

## Publish it safely

1. Keep `listen.host` on the loopback. A tunnel (Cloudflare Tunnel, `examples/cloudflared.yml`) is the only way in, and the database port never leaves the machine.
2. Map the tunnel hostname `api.<domain>` to `http://127.0.0.1:8102` and end the ingress list with `http_status:404`.
3. Set `clientIpHeader` to `cf-connecting-ip`, or every request seems to come from the tunnel and the rate limit counts everyone together.
4. Keep the token in a secret store, read through a `command` or `file` reference, and in the app's host as a secret environment variable.
5. Keep `healthDetails` false on a public gateway.

## Prove it works

`/healthz` only says the process is alive. It never touches a database. Prove the data path with a real statement through the public address.

```bash
curl -s https://api.example.com/sql \
  -H "content-type: application/json" \
  -H "neon-connection-string: postgresql://shop_ro:$SQLGATE_TOKEN@pg.example.com/shop" \
  -d '{"query":"select current_user as u, count(*) as n from pg_tables","params":[]}'
```

The host inside the connection string is not used by sqlgate (only user, password and database are), so the check works even where `pg.example.com` does not resolve. Without `neon-array-mode: true` you get row objects. Every value is the text Postgres produced (a count arrives as `"54"`), because the driver parses values from `dataTypeID`.

Then check the refusals. A missing header, a wrong token, an unlisted role and an unlisted database must all give 401. `GET /sql` gives 404. A write as a read-only role gives 400 with `"code":"42501"`.

To prove an app really moved, watch the statement log while you load a page. Each line names the database and role (`[sqlgate] shop/shop_app ... -> 3 rows in 4ms from <ip>`). A page that renders real data while no line appears is still reading the old database. A stronger proof is a marker row. Insert it at home, see it on the live site, delete it.

## Move the data

1. Dump the hosted database, restore it locally, and compare `count(*)` per table against the original. Do not trust `pg_stat_user_tables.n_live_tup`, which reads zero until `ANALYZE` runs.
2. Change `DATABASE_URL` in the app's host and redeploy. Hosts such as Vercel apply environment changes to new builds only. A local `.env.local` overrides `.env` in Next.js, so a local server can keep using a stale value.
3. A secret environment variable read back with `vercel env pull` comes back as the placeholder `[SENSITIVE]`. Test the route with a request instead of reading the value.
4. Make the app's build independent of the database. A build that queries the database fails whenever the gateway or tunnel is down.

## Shadow comparison before switching a live gateway

Run the new gateway beside the old one on another port and send both the same requests.

1. Copy the live config, change `listen.port` (for example to 8112) and start `sqlgate --config` on the copy.
2. For each database and role send a count query, an array mode query (`neon-array-mode: true`) and a write as the read-only role. Add a wrong token, an unlisted role, `/rest/v1/`, a `/job` with a wrong `x-gateway-token`, and an unknown path.
3. Compare status and raw body bytes. Compare `/healthz` as parsed JSON, since key order may differ.
4. Every case must be identical before you switch. Stop the copy by its port afterwards.

Comparing against hosted Neon itself is different. The field metadata carries table OIDs, which differ between clusters, so compare the rows the driver returns, not the raw HTTP bodies.

## Swap the live service with a rollback

1. Install the package into a service folder at a pinned version and keep the old service files untouched as the way back.
2. Copy the service definition aside, then change only the command line. Keep the same launchd label, port and log paths so monitors keep matching.
3. Restart it (`launchctl bootout gui/$(id -u)/<label>` then `launchctl bootstrap gui/$(id -u) <plist>`).
4. Wait for `/healthz`, check the listener on the port is the new process, then run the data checks locally and through the public hostname.
5. If any check fails, restore the saved definition, bootstrap it again and confirm the old gateway answers. Write this as one script and test the rollback path. A script whose `PATH` lacks `/usr/sbin` cannot find `lsof`, and that check then fails for the wrong reason.
6. Expect less than a minute of 500 and 504 answers on hosted pages while the new process starts cold. Afterwards watch the log for real app traffic with zero errors for half an hour.

## Run it as a service

- macOS uses `examples/com.example.sqlgate.plist`. launchd gives agents a minimal `PATH`, so name `node` by its full path and set `PATH` in `EnvironmentVariables`. `KeepAlive` restarts it. Restart by hand with `launchctl kickstart -k gui/$(id -u)/<label>`.
- Linux uses `examples/sqlgate.service`, with secrets in `EnvironmentFile`, then `systemctl enable --now sqlgate`.
- An idle pool client emits an error when Postgres restarts. sqlgate logs it and drops the client. Prove it by restarting Postgres under the running gateway and sending the next query.

## Transactions, batches and the MySQL side

- `sql.transaction([...])` runs on one connection between `BEGIN` and `COMMIT`, and any error rolls the whole batch back. The driver's `neon-batch-isolation-level`, `neon-batch-read-only` and `neon-batch-deferrable` headers become `BEGIN` options, and only known values are used.
- Each request is its own transaction. An interactive transaction across requests is not possible, and Neon's WebSocket mode is not supported.
- On `/mysql` every statement commits on its own. `commit()` does nothing and `rollback()` cannot undo a sent statement. A request carries one statement, and two are refused. `executemany` sends one request per row.
- Work that needs a real transaction, schema changes (`create_all`, migrations), or one lookup per row over a whole table belongs next to the database. Each lookup through the gateway is its own HTTPS round trip, and hundreds of thousands of them fit in no function timeout.

## Long work through jobs

A hosted page sends `{"job":"<name>"}` to `/job` with the `x-gateway-token` header. The caller names a job, never a URL, and every job URL must be on the loopback. sqlgate waits `answerMs` (3 s) for the job server's first answer. A 2xx means started (202), a 409 becomes "already running" (409), an error or no connection becomes 502 with the reason, and silence means running. sqlgate's own "running" memory is lost on restart and never sees callers that reach the job server directly, so the job server must keep its own lock and answer 409.

## Body size and 413

The Neon driver sends a `Buffer` parameter as a hex string, so a request is a little over twice the binary size. With 8 MB, a file of about 3.9 MB fits. Shrink images before storing them rather than raising the limit. An oversized body is read and discarded, then answered with 413 `{"message":"body too large"}`. Past four times the limit the answer goes out at once and a client still uploading may see a broken pipe. A broken upload is a 400 `request stream failed`, never a 413.

## Backups

- `pg_dump` per database does not include roles. Also run `pg_dumpall --globals-only` and check the file contains `CREATE ROLE`, or a restore brings back tables that no role can read.
- Prove a backup by restoring it with a client of the server's major version, not by its size.
- Keep the sqlgate config, the service definition and the tunnel config in version control. They hold only references, never secrets.
- Watch each served database's size as well as reachability. An empty restored database passes every other check while pages render blank.

## Rotate the token

Put the new token in the first reference and the old one in the second. Move each app to the new token, then clear the second. sqlgate reads tokens again every `tokenRefreshSeconds`, so nothing restarts. Check new token 200, old token 200, wrong token 401, then clear the old one.

## Failure catalogue

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| App calls `https://api.0.0.1/sql` | Neon driver given a local URL | the error text | use the public hostname or `fetchEndpoint` |
| TLS handshake fails to `api.db.example.com` | free certificate covers one label only | `curl -v` | use `pg.example.com`, or a certificate for the deeper name |
| Build fails with `ENOTFOUND` on the gateway host | app sends unknown hosts to a socket driver | the driver choice code | treat the gateway host as HTTP, keep the build off the database |
| 401 `no connection string` | header missing | request headers | send `neon-connection-string` (or `sql-connection-string`) |
| 401 `unauthorised` | wrong, stale or short token | log line `refused from` | check both token references and length of 24 or more |
| 401 `database not served here` / `role not served for` | name not listed | `postgres.databases` | add the database or role |
| 400 with `"code":"42501"` | role lacks the grant | `\dp` in psql | grant it, or use the writer role |
| 413 `body too large` | binary parameter doubled by hex | request size | shrink the payload, or raise `maxBodyBytes` |
| 429 `too many requests` | all callers share one address | `clientIpHeader` | set it to the tunnel's client IP header |
| 403 with error 1010 from Python | Cloudflare bot check on the default user agent | response body | send a user agent (the client does) |
| Site works but the log shows no traffic | app still on the old database | statement log, `.env.local`, last deploy time | fix the variable and redeploy |
| `/healthz` 200 but pages fail | health checks the process only | a real query | monitor with a query and database size |
| Gateway exits after a Postgres restart | idle client error with no listener | log `idle client error` | sqlgate handles it, check app pools too |
| Two runs of one job at the same time | lock kept only in the gateway | job server log | make the job server refuse with 409 |
| Process exits at start with code 3 | no readable token | stderr | fix the reference or the secret store |
| Batch partly written after an error | old gateway without transactions | rollback test | upgrade sqlgate, run the rollback test |
