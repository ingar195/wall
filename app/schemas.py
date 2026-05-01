from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ZoneView:
    zone_id: str
    name: str
    x: int
    y: int
    w: int
    h: int
    source_id: int | None = None
    source_name: str | None = None
    proxy_url: str | None = None