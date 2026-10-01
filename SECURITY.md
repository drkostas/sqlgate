# Security

sqlgate puts SQL behind a public address. Anyone who has the token can run any statement the role allows, so the token and the role rights are the whole defence.

## What sqlgate does

- Listens on the loopback only, unless the config says otherwise on purpose. A tunnel is the only way in.
- Compares the token in constant time and ignores tokens shorter than 24 characters.
- Serves only the databases and roles in the config. Any other name is refused before a connection opens.
- Limits requests per client address (240 a minute by default) and refuses bodies over 8 MB.
- Allows one statement per MySQL request.
- Starts jobs by name only, and only on the loopback, so it cannot be used to reach other services.
- Keeps secrets out of the config file. The config holds references to environment variables, files or commands.

## What you need to do

- Use a long random token (`openssl rand -hex 32`) and keep it in a secret store, not in the repository of the app.
- Give every app its own role with only the rights it needs. A dashboard that only reads should use a role that can only read. Never list the database owner or a superuser as a role.
- Keep `healthDetails` false unless you need it, so `/healthz` does not list your databases.
- Set `clientIpHeader` to the header your tunnel uses (`cf-connecting-ip` for Cloudflare). Without it every request seems to come from the tunnel, and the rate limit counts everyone together.
- Read the statement log regularly. Every statement is logged, shortened to 120 characters.
- Rotate the token when you suspect it leaked. The second token reference lets you do this without downtime.

## Reporting a problem

Please open a [security advisory](https://github.com/drkostas/sqlgate/security/advisories/new) on GitHub instead of a public issue.
