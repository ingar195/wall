"""Per-device shared secret, trust-on-first-use.

The Electron client generates a random secret once and sends it (with its device id) on every
request. The first secret a device id presents is stored (hashed); afterwards only that secret
is accepted, so knowing/guessing a device id is no longer enough to impersonate it, push
screenshots, or read the token-injecting /proxy. Admin can reset a device's secret.
"""
from __future__ import annotations

import hashlib
import secrets

from sqlalchemy.orm import Session

from app.config import settings
from app.models import Device

MIN_SECRET_LEN = 16


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def authenticate_device(db: Session, device_id: str, secret: str, create: bool = False) -> bool:
    """True if `secret` is valid for `device_id`. TOFU: a device without a stored secret adopts the first one.

    create=True lets an unknown device id register itself (needed for the pairing flow).
    """
    if not settings.device_auth:
        return True
    if not device_id or len(secret or "") < MIN_SECRET_LEN:
        return False
    device = db.get(Device, device_id)
    if device is None:
        if not create:
            return False
        device = Device(id=device_id, name=f"Screen {device_id}", status="offline")
    if device.secret_hash is None:
        device.secret_hash = hash_secret(secret)
        db.add(device)
        db.commit()
        return True
    return secrets.compare_digest(device.secret_hash, hash_secret(secret))
