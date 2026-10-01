import datetime
import json
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import sqlgate_client as sg


class FakeGateway:
    """A tiny HTTP server that records each request and answers with a canned reply."""

    def __init__(self):
        self.requests = []
        self.reply = (200, {"columns": [], "rows": [], "rowCount": 0, "lastRowId": 0})
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                fake.requests.append(({k.lower(): v for k, v in self.headers.items()}, body))
                status, payload = fake.reply
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def close(self):
        self.server.shutdown()


@pytest.fixture
def gw():
    fake = FakeGateway()
    yield fake
    fake.close()


def connect(gw):
    return sg.connect(host="127.0.0.1", port=gw.port, user="app_rw", password="tok/en:x", database="app")


def test_placeholders_become_bound_parameters(gw):
    cur = connect(gw).cursor()
    cur.execute("select * from t where a = %s and b like 'x%%' and c = %s", (1, b"\x00\xff"))
    headers, body = gw.requests[0]
    assert body["sql"] == "select * from t where a = ? and b like 'x%' and c = ?"
    assert body["params"] == [1, {"$b64": "AP8="}]
    assert headers["sql-connection-string"] == "mysql://app_rw:tok%2Fen%3Ax@sqlgate/app"
    assert headers["user-agent"].startswith("sqlgate-client/")


def test_no_arguments_leaves_the_statement_alone(gw):
    connect(gw).cursor().execute("select '100%%'")
    assert gw.requests[0][1] == {"sql": "select '100%%'", "params": []}


def test_values_are_rebuilt_from_their_column_types(gw):
    gw.reply = (
        200,
        {
            "columns": [
                {"name": "n", "type": 8},
                {"name": "d", "type": 246},
                {"name": "at", "type": 12},
                {"name": "day", "type": 10},
                {"name": "dur", "type": 11},
                {"name": "blob", "type": 252},
                {"name": "zero", "type": 12},
            ],
            "rows": [["9007199254740993", "1.50", "2026-01-02 03:04:05", "2026-01-02", "-26:00:01", {"$b64": "aGk="}, "0000-00-00 00:00:00"]],
            "rowCount": 1,
            "lastRowId": 0,
        },
    )
    cur = connect(gw).cursor()
    cur.execute("select 1")
    row = cur.fetchone()
    assert row == (
        9007199254740993,
        Decimal("1.50"),
        datetime.datetime(2026, 1, 2, 3, 4, 5),
        datetime.date(2026, 1, 2),
        -datetime.timedelta(hours=26, seconds=1),
        b"hi",
        None,
    )
    assert [d[0] for d in cur.description] == ["n", "d", "at", "day", "dur", "blob", "zero"]


def test_insert_reports_row_count_and_last_id(gw):
    gw.reply = (200, {"columns": [], "rows": [], "rowCount": 1, "lastRowId": 42})
    cur = connect(gw).cursor()
    cur.execute("insert into t values (%s)", (datetime.datetime(2026, 1, 2, 3, 4, 5, 600000),))
    assert (cur.rowcount, cur.lastrowid) == (1, 42)
    assert gw.requests[0][1]["params"] == ["2026-01-02 03:04:05.600"]


def test_mysql_errors_raise_the_matching_class(gw):
    gw.reply = (400, {"message": "Duplicate entry", "errno": 1062, "sqlState": "23000"})
    with pytest.raises(sg.IntegrityError):
        connect(gw).cursor().execute("insert into t values (1)")


def test_refusal_without_errno_is_operational(gw):
    gw.reply = (401, {"message": "unauthorised"})
    with pytest.raises(sg.OperationalError):
        connect(gw).cursor().execute("select 1")


def test_unreachable_server_is_operational():
    conn = sg.connect(host="127.0.0.1", port=1, user="u", password="p", database="d")
    with pytest.raises(sg.OperationalError, match="cannot reach"):
        conn.cursor().execute("select 1")


def test_executemany_sends_one_request_per_row(gw):
    gw.reply = (200, {"columns": [], "rows": [], "rowCount": 1, "lastRowId": 0})
    cur = connect(gw).cursor()
    cur.executemany("insert into t values (%s)", [(1,), (2,), (3,)])
    assert len(gw.requests) == 3 and cur.rowcount == 3
