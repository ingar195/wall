from __future__ import annotations

import json
import re
import secrets
from urllib.parse import urlparse
from contextlib import asynccontextmanager

import asyncio

import httpx
import websockets
from fastapi import Depends, FastAPI, Form, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.exc import OperationalError
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.database import Base, engine, get_db
from app.models import AuditLog, ContentSource, Device, Layout
from app.services import (
    add_audit_log,
    create_content_source,
    create_layout,
    delete_content_source,
    delete_device,
    delete_layout,
    ensure_pairing_code,
    get_layout_assignment_map,
    get_layout_zone_views,
    get_or_create_device,
    get_source_token,
    mark_device_seen,
    pair_device,
    set_layout_assignments,
    update_content_source,
    update_device,
    update_layout,
)
from app.websocket_hub import manager


def initialize_database_schema() -> None:
    try:
        Base.metadata.create_all(bind=engine)
    except OperationalError as exc:
        # SQLite + multi-worker startup can race on first boot; one worker creates
        # the table while another is still in DDL. Ignore only this known case.
        if "already exists" not in str(exc).lower():
            raise


class ProxyHeadersMiddleware(BaseHTTPMiddleware):
    """Middleware to handle X-Forwarded headers from reverse proxy"""
    async def dispatch(self, request: Request, call_next):
        # Get forwarded headers
        forwarded_proto = request.headers.get("x-forwarded-proto", "http")
        forwarded_host = request.headers.get("x-forwarded-host")
        forwarded_for = request.headers.get("x-forwarded-for")
        
        # Update scope with forwarded information
        if forwarded_proto:
            request.scope["scheme"] = forwarded_proto
        if forwarded_host:
            request.scope["server"] = (forwarded_host.split(":")[0], int(forwarded_host.split(":")[-1]) if ":" in forwarded_host else (443 if forwarded_proto == "https" else 80))
        if forwarded_for:
            # Get the client IP (first IP in the list if multiple)
            client_ip = forwarded_for.split(",")[0].strip()
            request.scope["client"] = (client_ip, 0)
        
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database_schema()
    app.state.http_client = httpx.AsyncClient(
        follow_redirects=False,
        timeout=30.0,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        http2=True,
    )
    yield
    await app.state.http_client.aclose()


app = FastAPI(title="DisplayManager V1", lifespan=lifespan)
# Add session middleware first (will be applied last, so runs last)
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret)
# Trust proxy headers for HTTPS behind reverse proxy
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*"])
# Proxy headers middleware must run first to update scope
app.add_middleware(ProxyHeadersMiddleware)
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


def redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url=url, status_code=303)


def get_or_create_csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        request.session["csrf_token"] = token
    return str(token)


def require_csrf(request: Request, submitted_token: str) -> None:
    expected_token = request.session.get("csrf_token")
    if not expected_token or not secrets.compare_digest(str(expected_token), submitted_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")


def is_admin_authenticated(request: Request) -> bool:
    return bool(request.scope.get("session", {}).get("admin_authenticated"))


def require_admin(request: Request) -> None:
    if not is_admin_authenticated(request):
        raise HTTPException(status_code=303, headers={"Location": "/admin/login"})


def audit(request: Request, db: Session, action: str, details: str) -> None:
    actor = request.scope.get("session", {}).get("admin_actor", "admin")
    add_audit_log(db, actor=actor, action=action, details=details)


def list_devices(db: Session) -> list[Device]:
    return list(db.scalars(select(Device).options(joinedload(Device.current_layout)).order_by(Device.created_at.desc())).unique().all())


def get_layout_editor_rows(db: Session) -> list[dict]:
    layouts = db.scalars(select(Layout).order_by(Layout.name)).all()
    rows: list[dict] = []
    for layout in layouts:
        assignment_map = get_layout_assignment_map(db, layout.id)
        zones = []
        for zone in layout.grid_configuration.get("zones", []):
            assignment = assignment_map.get(zone["id"])
            zones.append(
                {
                    "id": zone["id"],
                    "name": zone.get("name", zone["id"]),
                    "assignment": assignment,
                }
            )
        rows.append({"layout": layout, "zones": zones})
    return rows


def render_devices_panel(request: Request, db: Session) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "admin/_devices_panel.html",
        {"devices": list_devices(db), "csrf_token": get_or_create_csrf_token(request)},
    )


@app.get("/", response_class=HTMLResponse)
async def root() -> RedirectResponse:
    return redirect("/admin")


@app.get("/admin/login", response_class=HTMLResponse)
async def admin_login_page(request: Request) -> Response:
    if is_admin_authenticated(request):
        return redirect("/admin")
    return templates.TemplateResponse(
        request,
        "admin/login.html",
        {"error": request.query_params.get("error", ""), "csrf_token": get_or_create_csrf_token(request)},
    )


@app.post("/admin/login")
async def admin_login(request: Request, password: str = Form(...), csrf_token: str = Form(...)) -> RedirectResponse:
    require_csrf(request, csrf_token)
    if password != settings.admin_password:
        return redirect("/admin/login?error=1")
    request.session["admin_authenticated"] = True
    request.session["admin_actor"] = "admin"
    return redirect("/admin")


@app.post("/admin/logout")
async def admin_logout(request: Request, csrf_token: str = Form(...)) -> RedirectResponse:
    require_csrf(request, csrf_token)
    request.session.clear()
    return redirect("/admin/login")


@app.get("/admin", response_class=HTMLResponse)
async def admin_dashboard(request: Request, db: Session = Depends(get_db)) -> HTMLResponse:
    require_admin(request)
    layouts = db.scalars(select(Layout).order_by(Layout.name)).all()
    sources = db.scalars(select(ContentSource).order_by(ContentSource.name)).all()
    audit_logs = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(12)).all()
    return templates.TemplateResponse(
        request,
        "admin/dashboard.html",
        {
            "devices": list_devices(db),
            "layouts": layouts,
            "sources": sources,
            "layout_editor_rows": get_layout_editor_rows(db),
            "audit_logs": audit_logs,
            "csrf_token": get_or_create_csrf_token(request),
        },
    )


@app.get("/admin/partials/devices", response_class=HTMLResponse)
async def admin_devices_partial(request: Request, db: Session = Depends(get_db)) -> HTMLResponse:
    require_admin(request)
    return render_devices_panel(request, db)


@app.post("/admin/sources")
async def admin_create_source(
    request: Request,
    name: str = Form(...),
    base_url: str = Form(...),
    api_token: str = Form(""),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    source = create_content_source(db, name=name, base_url=base_url, api_token=api_token)
    audit(request, db, "source.create", f"Created source {source.name} ({source.id})")
    return redirect("/admin")


@app.post("/admin/sources/{source_id}/update")
async def admin_update_source(
    request: Request,
    source_id: int,
    name: str = Form(...),
    base_url: str = Form(...),
    api_token: str = Form(""),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    source = db.get(ContentSource, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Unknown source")
    update_content_source(db, source, name=name, base_url=base_url, api_token=api_token)
    audit(request, db, "source.update", f"Updated source {source.name} ({source.id})")
    return redirect("/admin")


@app.post("/admin/sources/{source_id}/delete")
async def admin_delete_source(
    request: Request,
    source_id: int,
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    source = db.get(ContentSource, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Unknown source")
    audit(request, db, "source.delete", f"Deleted source {source.name} ({source.id})")
    delete_content_source(db, source)
    return redirect("/admin")


@app.post("/admin/layouts")
async def admin_create_layout(
    request: Request,
    name: str = Form(...),
    grid_configuration: str = Form(""),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    layout = create_layout(db, name=name, grid_configuration=grid_configuration)
    audit(request, db, "layout.create", f"Created layout {layout.name} ({layout.id})")
    return redirect("/admin")


@app.post("/admin/layouts/{layout_id}/update")
async def admin_update_layout(
    request: Request,
    layout_id: int,
    name: str = Form(...),
    grid_configuration: str = Form(""),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    layout = db.get(Layout, layout_id)
    if not layout:
        raise HTTPException(status_code=404, detail="Unknown layout")
    update_layout(db, layout, name=name, grid_configuration=grid_configuration)
    audit(request, db, "layout.update", f"Updated layout {layout.name} ({layout.id})")
    assigned_devices = db.scalars(select(Device).where(Device.current_layout_id == layout.id)).all()
    for device in assigned_devices:
        await manager.send(device.id, {"action": "new_layout"})
    return redirect("/admin")


@app.post("/admin/layouts/{layout_id}/delete")
async def admin_delete_layout(
    request: Request,
    layout_id: int,
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    layout = db.get(Layout, layout_id)
    if not layout:
        raise HTTPException(status_code=404, detail="Unknown layout")
    affected_devices = db.scalars(select(Device).where(Device.current_layout_id == layout.id)).all()
    affected_ids = [device.id for device in affected_devices]
    audit(request, db, "layout.delete", f"Deleted layout {layout.name} ({layout.id})")
    delete_layout(db, layout)
    for device_id in affected_ids:
        await manager.send(device_id, {"action": "new_layout"})
    return redirect("/admin")


@app.post("/admin/layouts/{layout_id}/assignments")
async def admin_set_layout_assignments(
    request: Request,
    layout_id: int,
    zone_id: list[str] = Form(...),
    source_id: list[str] = Form(...),
    relative_path: list[str] = Form(...),
    assignment_type: list[str] = Form(...),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    assignments: list[dict] = []
    for current_zone_id, current_source_id, current_relative_path, current_type in zip(zone_id, source_id, relative_path, assignment_type, strict=True):
        if current_source_id.strip():
            assignments.append(
                {
                    "zone_id": current_zone_id,
                    "source_id": int(current_source_id),
                    "relative_path": current_relative_path,
                    "assignment_type": current_type,
                }
            )
    set_layout_assignments(db, layout_id, assignments)
    audit(request, db, "layout.assignments", f"Updated assignments for layout {layout_id}")
    assigned_devices = db.scalars(select(Device).where(Device.current_layout_id == layout_id)).all()
    for device in assigned_devices:
        await manager.send(device.id, {"action": "new_layout"})
    return redirect("/admin")


@app.post("/admin/devices/pair")
async def admin_pair_device(
    request: Request,
    pairing_code: str = Form(...),
    device_name: str = Form(...),
    layout_id: int | None = Form(default=None),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    device = pair_device(db, pairing_code=pairing_code, name=device_name, layout_id=layout_id)
    audit(request, db, "device.pair", f"Paired device {device.name} ({device.id})")
    await manager.send(device.id, {"action": "new_layout"})
    return redirect("/admin")


@app.post("/admin/devices/{device_id}/update")
async def admin_update_device(
    request: Request,
    device_id: str,
    device_name: str = Form(...),
    layout_id: int | None = Form(default=None),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Unknown device")
    update_device(db, device, name=device_name, layout_id=layout_id)
    audit(request, db, "device.update", f"Updated device {device.name} ({device.id})")
    await manager.send(device.id, {"action": "new_layout"})
    return redirect("/admin")


@app.post("/admin/devices/{device_id}/delete")
async def admin_delete_device(
    request: Request,
    device_id: str,
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    require_admin(request)
    require_csrf(request, csrf_token)
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Unknown device")
    audit(request, db, "device.delete", f"Deleted device {device.name} ({device.id})")
    delete_device(db, device)
    return redirect("/admin")


@app.post("/admin/devices/{device_id}/refresh")
async def admin_refresh_device(
    request: Request,
    device_id: str,
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
) -> Response:
    require_admin(request)
    require_csrf(request, csrf_token)
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Unknown device")
    await manager.send(device.id, {"action": "refresh"})
    audit(request, db, "device.refresh", f"Sent refresh to device {device.name} ({device.id})")
    if request.headers.get("HX-Request") == "true":
        return render_devices_panel(request, db)
    return redirect("/admin")


@app.get("/api/device/{device_id}")
async def api_device_layout(device_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    """JSON endpoint consumed by the Electron display client."""
    device = get_or_create_device(db, device_id)
    if not device.current_layout_id:
        device = ensure_pairing_code(db, device)
        return {
            "status": "unpaired",
            "device_id": device.id,
            "pairing_code": device.pairing_code,
        }

    device = mark_device_seen(db, device_id)
    layout = db.scalars(select(Layout).where(Layout.id == device.current_layout_id)).first()
    if not layout:
        raise HTTPException(status_code=500, detail="Assigned layout not found")

    zones = get_layout_zone_views(db, layout)
    base = str(request.base_url).rstrip("/")
    return {
        "status": "paired",
        "device_id": device.id,
        "device_name": device.name,
        "layout": {
            "id": layout.id,
            "name": layout.name,
            "columns": layout.grid_configuration.get("columns", 1),
            "rows": layout.grid_configuration.get("rows", 1),
        },
        "zones": [
            {
                "id": zone.zone_id,
                "name": zone.name,
                "x": zone.x,
                "y": zone.y,
                "w": zone.w,
                "h": zone.h,
                "url": zone.redirect_url or (base + zone.proxy_url if zone.proxy_url else None),
            }
            for zone in zones
        ],
    }


@app.get("/display/{device_id}", response_model=None)
async def display_device(request: Request, device_id: str, db: Session = Depends(get_db)) -> Response:
    device = get_or_create_device(db, device_id)
    if not device.current_layout_id:
        device = ensure_pairing_code(db, device)
        return templates.TemplateResponse(
            request,
            "display/pairing.html",
            {"device": device},
        )

    device = mark_device_seen(db, device_id)
    layout = db.scalars(select(Layout).where(Layout.id == device.current_layout_id)).first()
    if not layout:
        raise HTTPException(status_code=500, detail="Assigned layout not found")
    zones = get_layout_zone_views(db, layout)
    
    # Check if this layout has a single redirect zone - if so, redirect immediately
    redirect_zones = [z for z in zones if z.assignment_type == "redirect" and z.redirect_url]
    if redirect_zones:
        # Redirect to the first redirect zone's URL
        return redirect(redirect_zones[0].redirect_url)
    
    return templates.TemplateResponse(
        request,
        "display/layout.html",
        {"device": device, "layout": layout, "zones": zones},
    )


@app.websocket("/ws/device/{device_id}")
async def device_socket(websocket: WebSocket, device_id: str, db: Session = Depends(get_db)) -> None:
    await manager.connect(device_id, websocket)
    mark_device_seen(db, device_id)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                mark_device_seen(db, device_id)
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        device = get_or_create_device(db, device_id)
        device.status = "offline"
        db.add(device)
        db.commit()
        await manager.disconnect(device_id, websocket)


@app.websocket("/proxy/{target_app_id}/{path:path}")
async def proxy_websocket(target_app_id: int, path: str, websocket: WebSocket, db: Session = Depends(get_db)) -> None:
    try:
        source, token = get_source_token(db, target_app_id)
    except ValueError:
        await websocket.close(code=1008)
        return

    parsed = urlparse(source.base_url)
    is_public_status_source = parsed.path.startswith("/status/")
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    origin = f"{ws_scheme}://{parsed.netloc}"
    upstream_url = f"{origin}/{path.lstrip('/')}"
    if websocket.url.query:
        upstream_url = f"{upstream_url}?{websocket.url.query}"

    await websocket.accept()
    try:
        async with websockets.connect(
            upstream_url,
            extra_headers=({"Authorization": f"Bearer {token}"} if token.strip() and not is_public_status_source else None),
            open_timeout=10,
        ) as upstream:
            async def client_to_upstream() -> None:
                try:
                    async for msg in websocket.iter_bytes():
                        await upstream.send(msg)
                except Exception:
                    pass

            async def upstream_to_client() -> None:
                try:
                    async for msg in upstream:
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            await websocket.send_text(msg)
                except Exception:
                    pass

            tasks = [
                asyncio.ensure_future(client_to_upstream()),
                asyncio.ensure_future(upstream_to_client()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.api_route("/proxy/{target_app_id}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy_request(target_app_id: int, path: str, request: Request, db: Session = Depends(get_db)) -> Response:
    try:
        source, token = get_source_token(db, target_app_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    parsed = urlparse(source.base_url)
    is_public_status_source = parsed.path.startswith("/status/")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    print(f"[PROXY] Source base_url: {source.base_url}, origin: {origin}, path: {path}")
    if path:
        # Asset/sub-page requests: root at origin so absolute-path assets resolve correctly
        upstream_url = f"{origin}/{path.lstrip('/')}"
    else:
        # Initial page load: use the full base_url (may include a path prefix like /status/osc)
        upstream_url = source.base_url
    if request.url.query:
        upstream_url = f"{upstream_url}?{request.url.query}"

    body = await request.body()
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length"}
    }
    if token.strip() and not is_public_status_source:
        headers["authorization"] = f"Bearer {token}"

    client: httpx.AsyncClient = request.app.state.http_client
    upstream_response = await client.request(
        request.method,
        upstream_url,
        content=body,
        headers=headers,
    )

    excluded = {
        "transfer-encoding",
        "connection",
        "x-frame-options",
        "frame-options",
        "x-frame-policy",
        "content-length",
        "keep-alive",
        "proxy-connection",
    }
    response_headers = {
        key: value
        for key, value in upstream_response.headers.items()
        if key.lower() not in excluded
    }
    # Remove CSP headers that would block the framed content
    for csp_key in list(response_headers.keys()):
        if csp_key.lower() in {"content-security-policy", "content-security-policy-report-only"}:
            del response_headers[csp_key]

    location = upstream_response.headers.get("location")
    if location:
        parsed_location = urlparse(location)
        if not parsed_location.scheme and not parsed_location.netloc:
            # Relative/absolute-path redirect from upstream
            if location.startswith("/"):
                response_headers["location"] = f"/proxy/{target_app_id}{location}"
            else:
                response_headers["location"] = f"/proxy/{target_app_id}/{location}"
        elif f"{parsed_location.scheme}://{parsed_location.netloc}" == origin:
            # Absolute upstream URL on same origin -> keep browser within proxy route
            rewritten = f"/proxy/{target_app_id}{parsed_location.path or '/'}"
            if parsed_location.query:
                rewritten = f"{rewritten}?{parsed_location.query}"
            if parsed_location.fragment:
                rewritten = f"{rewritten}#{parsed_location.fragment}"
            response_headers["location"] = rewritten

    content = upstream_response.content
    content_type = upstream_response.headers.get("content-type", "")
    content_encoding = upstream_response.headers.get("content-encoding", "").lower().strip()
    is_encoded_body = bool(content_encoding and content_encoding != "identity")
    proxy_root = f"/proxy/{target_app_id}"
    body_rewritten = False

    if (not is_encoded_body) and "text/html" in content_type:
        text = content.decode("utf-8", errors="replace")
        # Rewrite absolute paths in src/href/action attributes
        text = re.sub(
            r'((?:src|href|action)=["\'])(/)',
            lambda m: m.group(1) + proxy_root + "/",
            text,
        )
        # JS shim: intercept fetch/XHR/WebSocket to route same-origin calls through proxy
        shim = f"""<script>
(function(){{
    var P='{proxy_root}';
    function rw(u){{
        if(typeof u!=='string')return u;
        if(u.startsWith('/')&&!u.startsWith(P))return P+u;
        try{{
            var pu=new URL(u);
            if(pu.host===location.host&&!pu.pathname.startsWith(P)){{
                pu.pathname=P+pu.pathname;
                return pu.toString();
            }}
        }}catch(e){{}}
        return u;
    }}
    var _f=window.fetch;
    window.fetch=function(input,init){{
        if(typeof input==='string')input=rw(input);
        else if(input&&input.url)input=new Request(rw(input.url),input);
        return _f.call(this,input,init);
    }};
    var _o=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){{
        var args=Array.prototype.slice.call(arguments);
        args[1]=rw(u);
        return _o.apply(this,args);
    }};
    var _W=window.WebSocket;
    function PW(url,protos){{
        url=rw(String(url));
        if(url.startsWith('http://'))url='ws://'+url.slice(7);
        else if(url.startsWith('https://'))url='wss://'+url.slice(8);
        return protos?new _W(url,protos):new _W(url);
    }}
    PW.prototype=_W.prototype;
    PW.CONNECTING=_W.CONNECTING;PW.OPEN=_W.OPEN;
    PW.CLOSING=_W.CLOSING;PW.CLOSED=_W.CLOSED;
    window.WebSocket=PW;
    if(navigator.serviceWorker){{
        navigator.serviceWorker.register=function(){{ return Promise.resolve(); }};
    }}
}})();
</script>"""
        # Inject base tag + shim right after <head>
        base_tag = f'<base href="{proxy_root}/">'
        inject = base_tag + shim
        if "<head>" in text:
            text = text.replace("<head>", f"<head>{inject}", 1)
        elif "<HEAD>" in text:
            text = text.replace("<HEAD>", f"<HEAD>{inject}", 1)
        else:
            text = inject + text
        content = text.encode("utf-8")
        body_rewritten = True
    elif (not is_encoded_body) and "text/css" in content_type:
        text = content.decode("utf-8", errors="replace")
        # Rewrite absolute url() references in CSS
        text = re.sub(r'url\(["\']?(/)', lambda m: f"url({proxy_root}/", text)
        content = text.encode("utf-8")
        body_rewritten = True

    # Never send a body for body-less responses to keep protocol framing valid.
    status_code = upstream_response.status_code
    if request.method.upper() == "HEAD" or 100 <= status_code < 200 or status_code in {204, 304}:
        content = b""

    # Ensure stale length/encoding headers can never leak through after rewrites.
    for header_name in list(response_headers.keys()):
        lowered = header_name.lower().strip()
        if lowered in {"content-length", "transfer-encoding", "connection"}:
            response_headers.pop(header_name, None)
        if lowered == "content-encoding" and (body_rewritten or request.method.upper() == "HEAD" or status_code in {204, 304}):
            response_headers.pop(header_name, None)

    return Response(
        content=content,
        status_code=status_code,
        headers=response_headers,
        media_type=content_type or None,
    )