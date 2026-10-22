import os
import re

import pytest
from starlette.websockets import WebSocketDisconnect

from fastapi.testclient import TestClient

import app.main as main
from app.config import settings
from app.main import app

SECRET_A = "a" * 32
SECRET_B = "b" * 32
HOST = {"host": "localhost"}


def auth(device_id, secret=SECRET_A):
    return {"X-Device-Id": device_id, "X-Device-Secret": secret}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(settings, "device_auth", True)
    main.engine.dispose()
    with TestClient(app, base_url="http://localhost") as c:
        yield c
    main.engine.dispose()
    try:
        os.remove("_test.db")
    except OSError:
        pass


def admin(c):
    main._login_fails.clear()
    tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/admin/login").text).group(1)
    c.post("/admin/login", data={"password": "change-me", "csrf_token": tok}, follow_redirects=False)
    return tok


def test_missing_or_short_secret_rejected(client):
    assert client.get("/api/device/d1").status_code == 401
    assert client.get("/api/device/d1", headers=auth("d1", "short")).status_code == 401


def test_first_secret_wins_then_others_rejected(client):
    assert client.get("/api/device/d1", headers=auth("d1")).json()["status"] == "unpaired"
    assert client.get("/api/device/d1", headers=auth("d1")).status_code == 200
    assert client.get("/api/device/d1", headers=auth("d1", SECRET_B)).status_code == 401  # impersonation attempt


def test_secret_is_stored_hashed(client):
    client.get("/api/device/d1", headers=auth("d1"))
    from app.database import SessionLocal
    from app.models import Device

    with SessionLocal() as db:
        stored = db.get(Device, "d1").secret_hash
    assert stored and SECRET_A not in stored and len(stored) == 64


def test_screenshot_requires_matching_secret(client):
    client.get("/api/device/d1", headers=auth("d1"))
    assert client.post("/api/device/d1/screenshot/0", content=b"x").status_code == 401
    assert client.post("/api/device/d1/screenshot/0", content=b"x", headers=auth("d1", SECRET_B)).status_code == 401
    assert client.post("/api/device/d1/screenshot/0", content=b"x", headers=auth("d1")).status_code == 200


def test_screenshot_cannot_register_unknown_device(client):
    assert client.post("/api/device/ghost/screenshot/0", content=b"x", headers=auth("ghost")).status_code == 401


def test_display_page_requires_secret(client):
    assert client.get("/display/d1").status_code == 401
    assert client.get("/display/d1", headers=auth("d1")).status_code == 200


def test_device_websocket_requires_secret(client):
    client.get("/api/device/d1", headers=auth("d1"))
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/device/d1", headers=HOST):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/device/d1", headers={**HOST, **auth("d1", SECRET_B)}):
            pass
    with client.websocket_connect("/ws/device/d1", headers={**HOST, **auth("d1")}) as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_proxy_requires_admin_or_device(client, monkeypatch):
    tok = admin(client)
    client.post("/admin/sources", data={"name": "s", "base_url": "http://example.invalid", "api_token": "tok", "csrf_token": tok})
    client.get("/api/device/d1", headers=auth("d1"))

    anon = TestClient(app, base_url="http://localhost")
    assert anon.get("/proxy/1/x").status_code == 401
    assert anon.get("/proxy/1/x", headers=auth("d1", SECRET_B)).status_code == 401
    assert anon.get("/proxy/1/x", headers={"X-Device-Secret": SECRET_A}).status_code == 401  # no device id

    class Upstream:
        status_code, headers, content = 200, {"content-type": "text/plain"}, b"ok"

    seen = {}

    async def fake_request(method, url, **kw):
        seen.update(kw)
        return Upstream()

    monkeypatch.setattr(client.app.state.http_client, "request", fake_request)
    assert anon.get("/proxy/1/x", headers=auth("d1")).status_code == 200  # authenticated device
    assert client.get("/proxy/1/x").status_code == 200  # admin session
    assert not {"x-device-id", "x-device-secret"} & {k.lower() for k in seen["headers"]}  # never forwarded upstream


def test_admin_can_reset_secret(client):
    tok = admin(client)
    client.get("/api/device/d1", headers=auth("d1"))
    assert client.get("/api/device/d1", headers=auth("d1", SECRET_B)).status_code == 401
    r = client.post("/admin/devices/d1/reset-secret", data={"csrf_token": tok}, follow_redirects=False)
    assert r.status_code == 303
    assert client.get("/api/device/d1", headers=auth("d1", SECRET_B)).status_code == 200  # new secret adopted
    assert client.get("/api/device/d1", headers=auth("d1")).status_code == 401


def test_reset_secret_requires_admin_and_csrf(client):
    client.get("/api/device/d1", headers=auth("d1"))
    assert client.post("/admin/devices/d1/reset-secret", data={"csrf_token": "x"}, follow_redirects=False).status_code == 303
    tok = admin(client)
    assert client.post("/admin/devices/d1/reset-secret", data={"csrf_token": "wrong"}).status_code == 403
    assert tok


def test_device_auth_can_be_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "device_auth", False)
    assert client.get("/api/device/d1").status_code == 200
