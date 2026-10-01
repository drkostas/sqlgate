# Changelog

## 0.1.0

First release, published on npm as `@drkostas/sqlgate` (npm refuses the plain name as too close to `sqlite`).

- `POST /sql` for the Neon serverless driver, with array mode and `sql.transaction` batches as real transactions
- `POST /mysql` for the Python DB-API client in `clients/python`
- `/rest/v1/*` forwarded to PostgREST
- Named loopback jobs with `POST /job`
- Two tokens for rotation, constant time comparison, per address rate limit, statement log
- Config file with secret references (environment variable, file or command)
