import os
import re
import sqlite3
import types
from datetime import datetime

import pytest


from fastapi.testclient import TestClient  # noqa: E402

import app.main as main  # noqa: E402
from app import services  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    main.engine.dispose()
    with TestClient(app, base_url="http://localhost") as c:
        yield c
    main.engine.dispose()
    try:
        os.remove("_test.db")
    except OSError:
        pass


def login(c, password="change-me"):
    tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/admin/login").text).group(1)
    r = c.post("/admin/login", data={"password": password, "csrf_token": tok}, follow_redirects=False)
    return tok, r


def layout(**kw):
    return types.SimpleNamespace(**{"schedule_enabled": True, "schedule_days": None, "schedule_start": None, "schedule_end": None, **kw})


@pytest.mark.parametrize("now,expected", [("23:00", True), ("03:00", True), ("12:00", False), ("06:00", False), ("22:00", True)])
def test_overnight_schedule(monkeypatch, now, expected):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 5, int(now[:2]), int(now[3:]))

        def astimezone(self, tz=None):
            return self

    monkeypatch.setattr(services, "datetime", FakeDT)
    assert services.is_layout_active_now(layout(schedule_start="22:00", schedule_end="06:00")) is expected


def test_daytime_schedule_unchanged(monkeypatch):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 5, 12, 0)

        def astimezone(self, tz=None):
            return self

    monkeypatch.setattr(services, "datetime", FakeDT)
    assert services.is_layout_active_now(layout(schedule_start="08:00", schedule_end="17:00"))
    assert not services.is_layout_active_now(layout(schedule_start="13:00", schedule_end="17:00"))


def test_login_lockout_after_repeated_failures(client):
    main._login_fails.clear()
    for _ in range(main.LOGIN_MAX_FAILS):
        assert login(client, "wrong")[1].status_code == 303
    assert login(client, "change-me")[1].status_code == 429
    main._login_fails.clear()
    assert login(client, "change-me")[1].headers["location"] == "/admin"


def test_screenshot_display_index_capped(client):
    client.get("/api/device/d1")
    assert client.post("/api/device/d1/screenshot/16", content=b"x").status_code == 400
    assert client.post("/api/device/d1/screenshot/15", content=b"x").status_code == 200


def test_input_is_audited_without_text(client):
    main._login_fails.clear()
    tok, _ = login(client)
    client.get("/api/device/d1")
    h = {"X-CSRF-Token": tok}
    client.post("/admin/wall/input", json={"device": "d1", "kind": "text", "text": "s3cret"}, headers=h)
    page = client.get("/admin").text
    assert "wall.input" in page and "s3cret" not in page


def test_old_database_gets_missing_columns():
    main.engine.dispose()
    try:
        os.remove("_test.db")
    except OSError:
        pass
    con = sqlite3.connect("_test.db")
    con.executescript("create table layouts(id integer primary key, name varchar(120), grid_configuration json);"
                      "create table layout_assignments(id integer primary key, layout_id int, zone_id varchar(100), source_id int, relative_path text);")
    con.commit()
    con.close()
    main._migrate_add_schedule_columns()
    main._migrate_add_schedule_columns()  # idempotent
    con = sqlite3.connect("_test.db")
    assert "assignment_type" in [r[1] for r in con.execute("pragma table_info(layout_assignments)")]
    assert "schedule_days" in [r[1] for r in con.execute("pragma table_info(layouts)")]
    con.close()
    main.engine.dispose()
    os.remove("_test.db")


def test_ws_proxy_uses_websockets_14_header_kwarg(client, monkeypatch):
    seen = {}

    class Boom(Exception):
        pass

    def fake_connect(url, **kw):
        seen.update(kw)
        raise Boom

    monkeypatch.setattr(main.websockets, "connect", fake_connect)
    tok, _ = login(client)
    client.post("/admin/sources", data={"name": "s", "base_url": "http://example.com", "api_token": "tok", "csrf_token": tok})
    try:
        with client.websocket_connect("/proxy/1/x", headers={"host": "localhost"}):
            pass
    except Exception:
        pass
    assert "additional_headers" in seen and "extra_headers" not in seen
