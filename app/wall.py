"""Wall view: live screenshots of every device display plus remote click/type.

Devices only capture while an admin is watching (short "lease" pushed over the
device WebSocket), so an idle wall costs nothing.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.device_auth import authenticate_device
from app.models import Device, WallLayout
from app.services import add_audit_log
from app.websocket_hub import manager

MAX_SHOT_BYTES = 8 * 1024 * 1024  # native-resolution fullscreen frames
MAX_DISPLAYS = 16
INPUT_KINDS = {"click", "key", "text", "scroll"}

# (device_id, display_index) -> (jpeg bytes, unix timestamp). In-memory on purpose:
# screenshots are ephemeral. ponytail: per-process; needs shared storage if uvicorn runs >1 worker.
_shots: dict[tuple[str, int], tuple[bytes, float]] = {}
_display_counts: dict[str, int] = {}


def validate_config(config: dict) -> dict:
    if not isinstance(config, dict) or not isinstance(config.get("tiles"), list):
        raise ValueError("config must be an object with a 'tiles' list")
    cols, rows = int(config.get("columns", 1)), int(config.get("rows", 1))
    if not (1 <= cols <= 32 and 1 <= rows <= 32):
        raise ValueError("columns/rows must be 1..32")
    tiles = []
    for t in config["tiles"]:
        tile = {
            "device": str(t["device"]),
            "display": int(t.get("display", 0)),
            "x": int(t.get("x", 0)),
            "y": int(t.get("y", 0)),
            "w": max(1, int(t.get("w", 1))),
            "h": max(1, int(t.get("h", 1))),
            "label": str(t.get("label", "")),
        }
        if tile["x"] < 0 or tile["y"] < 0 or tile["x"] + tile["w"] > cols or tile["y"] + tile["h"] > rows:
            raise ValueError(f"tile {tile['label'] or tile['device']} is outside the {cols}x{rows} grid")
        tiles.append(tile)
    return {"columns": cols, "rows": rows, "tiles": tiles}


def default_config(db: Session) -> dict:
    devices = db.scalars(select(Device).order_by(Device.name)).all()
    tiles = []
    for d in devices:
        for i in range(_display_counts.get(d.id, 1)):
            tiles.append({"device": d.id, "display": i, "x": len(tiles), "y": 0, "w": 1, "h": 1, "label": f"{d.name} #{i + 1}"})
    return {"columns": max(1, len(tiles)), "rows": 1, "tiles": tiles}


def make_wall_router(require_admin, require_csrf_header, get_csrf_token, templates) -> APIRouter:
    router = APIRouter()

    # ── device side ──────────────────────────────────────────────────────────
    @router.post("/api/device/{device_id}/screenshot/{display}")
    async def upload_shot(device_id: str, display: int, request: Request, db: Session = Depends(get_db)) -> dict:
        if not 0 <= display < MAX_DISPLAYS:
            raise HTTPException(status_code=400, detail="Bad display index")
        if not authenticate_device(db, device_id, request.headers.get("x-device-secret", "")):
            raise HTTPException(status_code=401, detail="Invalid device credentials")
        if not db.get(Device, device_id):
            raise HTTPException(status_code=404, detail="Unknown device")
        body = await request.body()
        if not body or len(body) > MAX_SHOT_BYTES:
            raise HTTPException(status_code=413, detail="Bad screenshot size")
        _shots[(device_id, display)] = (body, time.time())
        _display_counts[device_id] = max(_display_counts.get(device_id, 1), display + 1)
        return {"ok": True}

    # ── admin side ───────────────────────────────────────────────────────────
    @router.get("/admin/wall", response_class=HTMLResponse)
    async def wall_page(request: Request, layout: int | None = None, db: Session = Depends(get_db)) -> HTMLResponse:
        require_admin(request)
        layouts = db.scalars(select(WallLayout).order_by(WallLayout.name)).all()
        current = next((l for l in layouts if l.id == layout), layouts[0] if layouts else None)
        devices = db.scalars(select(Device).order_by(Device.name)).all()
        return templates.TemplateResponse(
            request,
            "admin/wall.html",
            {
                "layouts": [{"id": l.id, "name": l.name} for l in layouts],
                "current": {"id": current.id, "name": current.name} if current else None,
                "config": current.config if current else default_config(db),
                "devices": [{"id": d.id, "name": d.name} for d in devices],
                "csrf_token": get_csrf_token(request),
            },
        )

    @router.post("/admin/wall/layouts")
    async def save_layout(request: Request, db: Session = Depends(get_db)) -> dict:
        require_admin(request)
        require_csrf_header(request)
        data = await request.json()
        try:
            config = validate_config(data["config"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        name = str(data.get("name", "")).strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name required")
        row = db.get(WallLayout, data["id"]) if data.get("id") else None
        if row is None:
            row = db.scalars(select(WallLayout).where(WallLayout.name == name)).first() or WallLayout(name=name)
        row.name, row.config = name, config
        db.add(row)
        db.commit()
        return {"id": row.id}

    @router.delete("/admin/wall/layouts/{layout_id}")
    async def delete_wall_layout(layout_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
        require_admin(request)
        require_csrf_header(request)
        row = db.get(WallLayout, layout_id)
        if row:
            db.delete(row)
            db.commit()
        return {"ok": True}

    @router.post("/admin/wall/watch")
    async def watch(request: Request, db: Session = Depends(get_db)) -> dict:
        """Poll: renews capture leases on devices; returns online state + screenshot timestamps."""
        require_admin(request)
        require_csrf_header(request)
        data = await request.json()
        control = data.get("control")  # the device being remote-controlled captures faster
        full = bool(data.get("full"))  # viewer is fullscreen: ask for native resolution of that display
        control_display = max(-1, min(MAX_DISPLAYS - 1, int(data.get("display", 0))))  # -1 = all displays
        out = {}
        for device_id in {str(d) for d in data.get("devices", [])}:
            device = db.get(Device, device_id)
            if not device:
                continue
            # Desktop capture costs ~0.5 s of client CPU/GPU each time, so capture only as often as needed:
            # actively controlled -> back to back; controlled but idle -> 1.5 s; just watching the grid -> 5 s.
            if device_id == control:
                ms = 400 if data.get("active", True) else 1500
            else:
                ms = 5000
            lease = {"action": "capture", "ms": ms}
            if full and device_id == control:
                lease.update(full=True, display=control_display)
            online = await manager.send(device_id, lease)
            out[device_id] = {
                "name": device.name,
                "online": online,
                "shots": {str(i): ts for (d, i), (_, ts) in _shots.items() if d == device_id},
            }
        return out

    @router.get("/admin/wall/shot/{device_id}/{display}")
    async def get_shot(device_id: str, display: int, request: Request) -> Response:
        require_admin(request)
        shot = _shots.get((device_id, display))
        if not shot:
            raise HTTPException(status_code=404)
        return Response(shot[0], media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @router.post("/admin/wall/input")
    async def send_input(request: Request, db: Session = Depends(get_db)) -> dict:
        require_admin(request)
        require_csrf_header(request)
        data = await request.json()
        if data.get("kind") not in INPUT_KINDS:
            raise HTTPException(status_code=400, detail="Bad input kind")
        msg = {
            "action": "input",
            "kind": data["kind"],
            "display": min(MAX_DISPLAYS - 1, max(0, int(data.get("display", 0)))),
            "x": min(1.0, max(0.0, float(data.get("x", 0)))),
            "y": min(1.0, max(0.0, float(data.get("y", 0)))),
            "button": "right" if data.get("button") == "right" else "left",
            "key": str(data.get("key", ""))[:32],
            "text": str(data.get("text", ""))[:500],
            "dy": max(-2000, min(2000, int(data.get("dy", 0)))),
        }
        device_id = str(data.get("device", ""))
        if msg["kind"] != "scroll":  # scroll is noise; never log typed text (may be a password)
            actor = request.scope.get("session", {}).get("admin_actor", "admin")
            add_audit_log(db, actor=actor, action="wall.input", details=f"{msg['kind']} on {device_id} display {msg['display']}")
        return {"delivered": await manager.send(device_id, msg)}

    @router.get("/splash", response_class=HTMLResponse)
    async def splash(request: Request, device: str = "", display: int = 0, db: Session = Depends(get_db)) -> HTMLResponse:
        # One logo across the whole wall: place this screen using the first saved wall layout that has this screen.
        # Region = bounding box (in grid cells) of this device's display tile(s); display -1 = all of them.
        wall = None
        for row in db.scalars(select(WallLayout).order_by(WallLayout.name)):
            tiles = [t for t in row.config["tiles"] if t["device"] == device and display in (-1, t["display"])]
            if tiles:
                x0, y0 = min(t["x"] for t in tiles), min(t["y"] for t in tiles)
                wall = {
                    "cols": row.config["columns"], "rows": row.config["rows"], "col": x0, "row": y0,
                    "cw": max(t["x"] + t["w"] for t in tiles) - x0, "rh": max(t["y"] + t["h"] for t in tiles) - y0,
                }
                break
        return templates.TemplateResponse(request, "display/splash.html", {"wall": wall})

    return router
