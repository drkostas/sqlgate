"""A DB-API driver that sends MySQL statements to a sqlgate server over HTTPS.

It implements the part of PEP 249 that SQLAlchemy uses. SQLAlchemy keeps its mysql+pymysql dialect,
so the SQL it generates does not change. Only the module that carries each statement is replaced:

    engine = create_engine(
        "mysql+pymysql://app_rw:<gateway token>@db.example.com/app",
        module=sqlgate_client,
    )

The endpoint is https://<host>/mysql, or http:// for a loopback host.

Every statement commits on its own, because the server keeps no session between requests.
commit() does nothing and rollback() cannot undo a statement that was already sent. Work that needs
two writes to succeed or fail together must run next to the database instead.
"""

import base64
import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

__version__ = "0.1.0"

apilevel = "2.0"
threadsafety = 1
# "format" (positional %s) because it is the simplest style to render exactly.
paramstyle = "format"


class Error(Exception):
    pass


class Warning(Exception):  # noqa: A001 - the DB-API name
    pass


class InterfaceError(Error):
    pass


class DatabaseError(Error):
    pass


class DataError(DatabaseError):
    pass


class OperationalError(DatabaseError):
    pass


class IntegrityError(DatabaseError):
    pass


class InternalError(DatabaseError):
    pass


class ProgrammingError(DatabaseError):
    pass


class NotSupportedError(DatabaseError):
    pass


# MySQL error numbers mapped to the classes a local driver raises, so an ORM's handling (a duplicate
# key as IntegrityError, for example) keeps working.
_BY_ERRNO = {
    1022: IntegrityError, 1048: IntegrityError, 1052: IntegrityError,
    1062: IntegrityError, 1169: IntegrityError, 1216: IntegrityError,
    1217: IntegrityError, 1451: IntegrityError, 1452: IntegrityError,
    1054: ProgrammingError, 1064: ProgrammingError, 1146: ProgrammingError,
    1142: ProgrammingError, 1046: ProgrammingError, 1149: ProgrammingError,
    1044: OperationalError, 1045: OperationalError, 1040: OperationalError,
    1264: DataError, 1265: DataError, 1366: DataError, 1406: DataError,
}

# MySQL protocol type codes. The server sends dates and big numbers as text with the column type,
# and they are rebuilt here into the same Python values a local driver returns.
_DECIMAL, _TINY, _SHORT, _LONG, _FLOAT, _DOUBLE = 0, 1, 2, 3, 4, 5
_TIMESTAMP, _LONGLONG, _INT24, _DATE, _TIME, _DATETIME, _YEAR = 7, 8, 9, 10, 11, 12, 13
_NEWDATE, _BIT, _JSON, _NEWDECIMAL = 14, 16, 245, 246

_INTS = {_TINY, _SHORT, _LONG, _LONGLONG, _INT24, _YEAR}
_FLOATS = {_FLOAT, _DOUBLE}
_DECIMALS = {_DECIMAL, _NEWDECIMAL}


def _to_datetime(value):
    # MySQL allows '0000-00-00 00:00:00'. A local driver returns None for it, and so does this.
    text = value.strip()
    if text.startswith("0000-00-00"):
        return None
    for shape in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(text, shape)
        except ValueError:
            continue
    return value


def _to_time(value):
    # MySQL TIME is a duration (it can be negative or longer than a day), so it becomes a timedelta.
    text = value.strip()
    sign = -1 if text.startswith("-") else 1
    parts = text.lstrip("-").split(":")
    try:
        hours, minutes = int(parts[0]), int(parts[1])
        seconds = float(parts[2]) if len(parts) > 2 else 0.0
    except (ValueError, IndexError):
        return value
    return sign * datetime.timedelta(hours=hours, minutes=minutes, seconds=seconds)


def _convert(value, type_code):
    if value is None:
        return None
    if isinstance(value, dict) and "$b64" in value:
        return base64.b64decode(value["$b64"])
    if type_code in _INTS:
        return int(value)
    if type_code in _FLOATS:
        return float(value)
    if type_code in _DECIMALS:
        return Decimal(str(value))
    if type_code in (_DATETIME, _TIMESTAMP):
        return _to_datetime(value) if isinstance(value, str) else value
    if type_code in (_DATE, _NEWDATE):
        parsed = _to_datetime(value) if isinstance(value, str) else value
        return parsed.date() if isinstance(parsed, datetime.datetime) else parsed
    if type_code == _TIME:
        return _to_time(value) if isinstance(value, str) else value
    return value


def _encodable(value):
    """Turn a bound parameter into something JSON can carry without changing its meaning."""
    if isinstance(value, (bytes, bytearray)):
        return {"$b64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, datetime.datetime):
        if value.microsecond:
            return value.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, datetime.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, datetime.timedelta):
        total = int(value.total_seconds())
        sign = "-" if total < 0 else ""
        total = abs(total)
        return f"{sign}{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    if isinstance(value, Decimal):
        return str(value)
    return value


def _render(sql, args):
    """Turn %s placeholders into the server's ? and keep the arguments bound.

    With no arguments the statement is sent unchanged, including any literal %%, which is what a
    local driver does too.
    """
    if args is None:
        return sql, []
    out, params, i, taken = [], [], 0, 0
    while i < len(sql):
        char = sql[i]
        if char == "%" and i + 1 < len(sql):
            following = sql[i + 1]
            if following == "%":
                out.append("%")
                i += 2
                continue
            if following == "s":
                out.append("?")
                params.append(_encodable(args[taken]) if taken < len(args) else None)
                taken += 1
                i += 2
                continue
        out.append(char)
        i += 1
    return "".join(out), params


def _raise(payload):
    errno = payload.get("errno")
    message = payload.get("message") or "database error"
    raise _BY_ERRNO.get(errno, ProgrammingError if errno else OperationalError)(errno, message)


class Cursor:
    def __init__(self, connection):
        self._connection = connection
        self._rows = []
        self._at = 0
        self.description = None
        self.rowcount = -1
        self.lastrowid = None
        self.arraysize = 1

    def close(self):
        # Nothing to release on the server: the statement has finished already.
        self._rows, self._at = [], 0

    def execute(self, sql, args=None):
        statement, params = _render(sql, args)
        answer = self._connection._post(statement, params)
        columns = answer.get("columns") or []
        self.description = tuple(
            (column["name"], column["type"], None, None, None, None, None) for column in columns
        ) or None
        types = [column["type"] for column in columns]
        self._rows = [
            tuple(_convert(value, types[index]) for index, value in enumerate(row))
            for row in answer.get("rows") or []
        ]
        self._at = 0
        self.rowcount = answer.get("rowCount", -1)
        self.lastrowid = answer.get("lastRowId") or None
        return self.rowcount

    def executemany(self, sql, seq_of_args):
        # One request per row. A batch would be faster, but it would have to decide what a failure in
        # the middle means, and there is no transaction to answer that.
        total = 0
        for args in seq_of_args:
            total += self.execute(sql, args) or 0
        self.rowcount = total
        return total

    def fetchone(self):
        if self._at >= len(self._rows):
            return None
        self._at += 1
        return self._rows[self._at - 1]

    def fetchmany(self, size=None):
        size = self.arraysize if size is None else size
        chunk = self._rows[self._at : self._at + size]
        self._at += len(chunk)
        return chunk

    def fetchall(self):
        chunk = self._rows[self._at :]
        self._at = len(self._rows)
        return chunk

    def setinputsizes(self, *_):
        pass

    def setoutputsize(self, *_):
        pass

    def __iter__(self):
        return iter(self.fetchall())


class Connection:
    def __init__(self, endpoint, connection_string, timeout, user_agent=None):
        self._endpoint = endpoint
        self._connection_string = connection_string
        self._timeout = timeout
        # Cloudflare's bot check refuses urllib's default user agent with a 403 ("error code: 1010"),
        # so the client names itself.
        self._user_agent = user_agent or f"sqlgate-client/{__version__}"
        self.closed = False

    def _post(self, sql, params):
        body = json.dumps({"sql": sql, "params": params}).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "sql-connection-string": self._connection_string,
                "user-agent": self._user_agent,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as failure:
            raw = failure.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                raise OperationalError(failure.code, raw[:500]) from failure
            _raise(payload)
        except urllib.error.URLError as failure:
            # An unreachable server is not a SQL error, so it is not reported as one.
            raise OperationalError(2003, f"cannot reach the sqlgate server: {failure.reason}") from failure

    def cursor(self):
        return Cursor(self)

    # Both are no-ops on purpose: every statement has committed by the time either is called.
    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True

    def ping(self, reconnect=True):  # noqa: ARG002 - the dialect passes it
        cursor = self.cursor()
        cursor.execute("SELECT 1")
        cursor.close()
        return True

    def character_set_name(self):
        return "utf8mb4"

    def autocommit(self, value):  # noqa: ARG002
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def connect(host=None, user=None, password=None, database=None, port=None, **_ignored):
    """Called by SQLAlchemy with the parts of the URL. The endpoint comes from the host."""
    host = host or os.getenv("SQLGATE_HOST") or "127.0.0.1"
    local = host in ("127.0.0.1", "localhost", "::1")
    scheme = "http" if local else "https"
    authority = f"{host}:{port}" if port else host
    endpoint = f"{scheme}://{authority}/mysql"
    quote = urllib.parse.quote
    connection_string = f"mysql://{quote(user or '', safe='')}:{quote(password or '', safe='')}@sqlgate/{quote(database or '', safe='')}"
    return Connection(endpoint, connection_string, float(os.getenv("SQLGATE_TIMEOUT", "20")))
