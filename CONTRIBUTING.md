# Contributing

Issues and pull requests are welcome.

## Run the tests

```bash
npm install
npm test
```

The Postgres and MySQL tests start throwaway servers in a temp folder when `initdb` and `mysqld` are installed. Without them those tests are skipped locally, and CI runs all of them.

The Python client has its own tests.

```bash
cd clients/python
python -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

## Pull requests

- Please add a test for every change in behaviour.
- Keep the request and response shapes compatible with the Neon serverless driver. The test in `test/postgres.test.js` runs the real driver against sqlgate, and it has to stay green.
- Add a line to `CHANGELOG.md` under "Unreleased".
