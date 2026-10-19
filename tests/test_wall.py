import os
import re

import pytest

os.environ["DB_PATH"] = "sqlite:///./_test_wall.db"
os.environ["ENCRYPTION_KEY"] = "a" * 43 + "="

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.wall import validate_config  # noqa: E402

CFG = {"columns": 2, "rows": 1, "tiles": [{"device": "d1", "display": 0, "x": 0, "y": 0}, {"device": "d1", "display": 1, "x": 1, "y": 0}]}


@pytest.fixture()
def client():
    with TestClient(app, base_url="http://localhost") as c:
        yield c
    for f in ("_test_wall.db",):
        try:
            os.remove(f)
        except OSError:
            pass


@pytest.fixture()
def admin(client):
    token = re.search(r'name="csrf_token" value="([^"]+)"', client.get("/admin/login").text).group(1)
    client.post("/admin/login", data={"password": "change-me", "csrf_token": token}, follow_redirects=False)
    client.get("/api/device/d1")  # registers device d1
    return client, {"X-CSRF-Token": token}


def test_validate_config_rejects_tile_outside_grid():
    with pytest.raises(ValueError):
        validate_config({**CFG, "columns": 1})
    assert validate_config(CFG)["tiles"][1]["w"] == 1


def test_screenshot_roundtrip_and_watch(admin):
    c, h = admin
    assert c.post("/api/device/d1/screenshot/1", content=b"\xff\xd8x").status_code == 200
    assert c.get("/admin/wall/shot/d1/1").content == b"\xff\xd8x"
    state = c.post("/admin/wall/watch", json={"devices": ["d1"]}, headers=h).json()
    assert state["d1"]["online"] is False and "1" in state["d1"]["shots"]


def test_screenshot_unknown_device_and_oversize(admin):
    c, _ = admin
    assert c.post("/api/device/nope/screenshot/0", content=b"x").status_code == 404
    assert c.post("/api/device/d1/screenshot/0", content=b"x" * (3 * 1024 * 1024 + 1)).status_code == 413


def test_layout_save_update_delete(admin):
    c, h = admin
    lid = c.post("/admin/wall/layouts", json={"name": "w", "config": CFG}, headers=h).json()["id"]
    assert c.post("/admin/wall/layouts", json={"id": lid, "name": "w2", "config": CFG}, headers=h).json()["id"] == lid
    assert "w2" in c.get("/admin/wall").text
    assert c.post("/admin/wall/layouts", json={"name": "bad", "config": {**CFG, "columns": 1}}, headers=h).status_code == 400
    c.delete(f"/admin/wall/layouts/{lid}", headers=h)
    assert "w2" not in c.get("/admin/wall").text


def test_input_requires_csrf_and_validates(admin):
    c, h = admin
    assert c.post("/admin/wall/input", json={"kind": "click"}).status_code == 403
    assert c.post("/admin/wall/input", json={"kind": "rm -rf"}, headers=h).status_code == 400
    assert c.post("/admin/wall/input", json={"device": "d1", "kind": "click", "x": 5}, headers=h).json() == {"delivered": False}


def test_input_delivered_to_connected_device(admin):
    c, h = admin
    with c.websocket_connect("/ws/device/d1", headers={"host": "localhost"}) as ws:
        assert c.post("/admin/wall/input", json={"device": "d1", "kind": "text", "text": "hi", "x": 5}, headers=h).json() == {"delivered": True}
        msg = ws.receive_json()
        assert msg["action"] == "input" and msg["text"] == "hi" and msg["x"] == 1.0  # clamped
        c.post("/admin/wall/watch", json={"devices": ["d1"], "control": "d1"}, headers=h)
        assert ws.receive_json() == {"action": "capture", "ms": 400}


def test_admin_routes_require_login(client):
    assert client.get("/admin/wall", follow_redirects=False).status_code == 303
    assert client.get("/admin/wall/shot/d1/0", follow_redirects=False).status_code == 303


def test_splash_page(client):
    assert "bounce" in client.get("/splash").text
