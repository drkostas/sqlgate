# sqlgate-client

A DB-API driver that sends MySQL statements to a [sqlgate](https://github.com/drkostas/sqlgate) server over HTTPS. It lets a SQLAlchemy app on a serverless host use a MySQL database that runs on your own machine.

```bash
pip install sqlgate-client
```

```python
import sqlalchemy as sa
import sqlgate_client

engine = sa.create_engine(
    "mysql+pymysql://blog_app:<token>@db.example.com/blog",
    module=sqlgate_client,
)
```

SQLAlchemy keeps its `mysql+pymysql` dialect, so the SQL your app sends does not change. Requests go to `https://<host>/mysql` (or `http://` for a loopback host). Dates, decimals, times and bytes come back as the same Python types a local driver returns, and MySQL errors raise the same exception classes.

Every statement commits on its own, because the server keeps no session between requests. `commit()` does nothing and `rollback()` cannot undo a statement that was already sent.

Settings from the environment are `SQLGATE_TIMEOUT` (seconds, default 20) and `SQLGATE_HOST` (used when the URL has no host).

## License

MIT
