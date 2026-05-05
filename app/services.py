from __future__ import annotations

import json
import re
import random
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, ContentSource, Device, Layout, LayoutAssignment
from app.schemas import ZoneView
from app.security import decrypt_token, encrypt_token


PAIRING_TTL_MINUTES = 10


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def default_grid_configuration() -> dict:
    return {
        "columns": 1,
        "rows": 1,
        "zones": [
            {"id": "zone-1", "name": "Zone 1", "x": 0, "y": 0, "w": 1, "h": 1}
        ],
    }


def normalize_grid_configuration(raw: str | None) -> dict:
    if not raw:
        return default_grid_configuration()
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or "zones" not in parsed:
        raise ValueError("grid_configuration must be a JSON object with a zones array")
    return parsed


def create_content_source(db: Session, name: str, base_url: str, api_token: str = "") -> ContentSource:
    source = ContentSource(
        name=name.strip(),
        base_url=base_url.rstrip("/"),
        encrypted_api_token=encrypt_token(api_token.strip()),
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


def update_content_source(db: Session, source: ContentSource, name: str, base_url: str, api_token: str | None) -> ContentSource:
    source.name = name.strip()
    source.base_url = base_url.rstrip("/")
    if api_token is not None:
        # Allow clearing a token by submitting an empty value.
        source.encrypted_api_token = encrypt_token(api_token.strip())
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


def delete_content_source(db: Session, source: ContentSource) -> None:
    assignments = db.scalars(select(LayoutAssignment).where(LayoutAssignment.source_id == source.id)).all()
    for assignment in assignments:
        db.delete(assignment)
    db.delete(source)
    db.commit()


def _parse_schedule_days(days: list[int] | None) -> list[int] | None:
    """Validate and normalise schedule_days; return None if empty."""
    if not days:
        return None
    return sorted({int(d) for d in days if 0 <= int(d) <= 6})


def _parse_hhmm(value: str | None) -> str | None:
    """Return a validated HH:MM string or None."""
    if not value or not value.strip():
        return None
    value = value.strip()
    if not re.match(r'^([01]\d|2[0-3]):[0-5]\d$', value):
        raise ValueError(f"Invalid time format: {value!r}. Expected HH:MM.")
    return value


def is_layout_active_now(layout: Layout) -> bool:
    """Return True if the layout is currently within its schedule, or if no schedule is configured."""
    if not layout.schedule_enabled:
        return True

    has_schedule = layout.schedule_start or layout.schedule_end or layout.schedule_days
    if not has_schedule:
        return True

    now = datetime.now(timezone.utc).astimezone()  # local server time
    if layout.schedule_days is not None:
        if now.weekday() not in layout.schedule_days:
            return False

    current_hhmm = now.strftime("%H:%M")
    if layout.schedule_start and current_hhmm < layout.schedule_start:
        return False
    if layout.schedule_end and current_hhmm >= layout.schedule_end:
        return False
    return True


def create_layout(
    db: Session,
    name: str,
    grid_configuration: str | None,
    schedule_enabled: bool = False,
    schedule_start: str | None = None,
    schedule_end: str | None = None,
    schedule_days: list[int] | None = None,
) -> Layout:
    layout = Layout(
        name=name.strip(),
        grid_configuration=normalize_grid_configuration(grid_configuration),
        schedule_enabled=bool(schedule_enabled),
        schedule_start=_parse_hhmm(schedule_start),
        schedule_end=_parse_hhmm(schedule_end),
        schedule_days=_parse_schedule_days(schedule_days),
    )
    db.add(layout)
    db.commit()
    db.refresh(layout)
    return layout


def update_layout(
    db: Session,
    layout: Layout,
    name: str,
    grid_configuration: str | None,
    schedule_enabled: bool = False,
    schedule_start: str | None = None,
    schedule_end: str | None = None,
    schedule_days: list[int] | None = None,
) -> Layout:
    layout.name = name.strip()
    layout.grid_configuration = normalize_grid_configuration(grid_configuration)
    layout.schedule_enabled = bool(schedule_enabled)
    layout.schedule_start = _parse_hhmm(schedule_start)
    layout.schedule_end = _parse_hhmm(schedule_end)
    layout.schedule_days = _parse_schedule_days(schedule_days)
    db.add(layout)
    db.commit()
    db.refresh(layout)
    return layout


def delete_layout(db: Session, layout: Layout) -> None:
    assignments = db.scalars(select(LayoutAssignment).where(LayoutAssignment.layout_id == layout.id)).all()
    for assignment in assignments:
        db.delete(assignment)
    devices = db.scalars(select(Device).where(Device.current_layout_id == layout.id)).all()
    for device in devices:
        device.current_layout_id = None
        db.add(device)
    db.delete(layout)
    db.commit()


def set_layout_assignments(db: Session, layout_id: int, assignments: list[dict]) -> None:
    existing = db.scalars(select(LayoutAssignment).where(LayoutAssignment.layout_id == layout_id)).all()
    for row in existing:
        db.delete(row)
    for assignment in assignments:
        db.add(
            LayoutAssignment(
                layout_id=layout_id,
                zone_id=assignment["zone_id"],
                source_id=int(assignment["source_id"]),
                relative_path=assignment.get("relative_path", "").strip(),
                assignment_type="redirect",
            )
        )
    db.commit()


def get_layout_assignment_map(db: Session, layout_id: int) -> dict[str, LayoutAssignment]:
    assignments = db.scalars(select(LayoutAssignment).where(LayoutAssignment.layout_id == layout_id)).all()
    return {assignment.zone_id: assignment for assignment in assignments}


def generate_pairing_code() -> str:
    return f"{random.randint(0, 9999):04d}"


def get_or_create_device(db: Session, device_id: str) -> Device:
    device = db.get(Device, device_id)
    if device:
        return device
    device = Device(id=device_id, name=f"Screen {device_id}", status="offline")
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def ensure_pairing_code(db: Session, device: Device) -> Device:
    now = utcnow()
    pairing_expires_at = as_utc(device.pairing_expires_at)
    if device.pairing_code and pairing_expires_at and pairing_expires_at > now:
        return device
    device.pairing_code = generate_pairing_code()
    device.pairing_expires_at = now + timedelta(minutes=PAIRING_TTL_MINUTES)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def pair_device(db: Session, pairing_code: str, name: str, layout_id: int | None) -> Device:
    now = utcnow()
    statement = select(Device).where(
        Device.pairing_code == pairing_code,
        Device.pairing_expires_at.is_not(None),
    )
    device = db.scalars(statement).first()
    if not device:
        raise ValueError("Invalid or expired pairing code")
    pairing_expires_at = as_utc(device.pairing_expires_at)
    if pairing_expires_at is None or pairing_expires_at < now:
        raise ValueError("Invalid or expired pairing code")
    device.name = name.strip() or device.name
    device.current_layout_id = layout_id
    device.pairing_code = None
    device.pairing_expires_at = None
    device.status = "online"
    device.last_ping = now
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def mark_device_seen(db: Session, device_id: str, status: str = "online") -> Device:
    device = get_or_create_device(db, device_id)
    device.status = status
    device.last_ping = utcnow()
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def update_device(db: Session, device: Device, name: str, layout_id: int | None) -> Device:
    device.name = name.strip() or device.name
    device.current_layout_id = layout_id
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def delete_device(db: Session, device: Device) -> None:
    db.delete(device)
    db.commit()


def get_layout_zone_views(db: Session, layout: Layout) -> list[ZoneView]:
    assignments = db.scalars(select(LayoutAssignment).where(LayoutAssignment.layout_id == layout.id)).all()
    assignment_map = {row.zone_id: row for row in assignments}
    zones = []
    for zone in layout.grid_configuration.get("zones", []):
        assignment = assignment_map.get(zone["id"])
        source = assignment.source if assignment else None
        proxy_url = None
        redirect_url = None
        assignment_type = "redirect"

        if assignment and source:
            # Always treat assignments as redirects: use full source URL
            redirect_url = source.base_url
        
        zones.append(
            ZoneView(
                zone_id=zone["id"],
                name=zone.get("name", zone["id"]),
                x=int(zone.get("x", 0)),
                y=int(zone.get("y", 0)),
                w=int(zone.get("w", 1)),
                h=int(zone.get("h", 1)),
                source_id=source.id if source else None,
                source_name=source.name if source else None,
                proxy_url=proxy_url,
                assignment_type=assignment_type,
                redirect_url=redirect_url,
            )
        )
    return zones


def get_source_token(db: Session, source_id: int) -> tuple[ContentSource, str]:
    source = db.get(ContentSource, source_id)
    if not source:
        raise ValueError("Unknown content source")
    return source, decrypt_token(source.encrypted_api_token)


def add_audit_log(db: Session, actor: str, action: str, details: str) -> AuditLog:
    audit_log = AuditLog(actor=actor, action=action, details=details)
    db.add(audit_log)
    db.commit()
    db.refresh(audit_log)
    return audit_log