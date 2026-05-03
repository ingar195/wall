from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ContentSource(Base):
    __tablename__ = "content_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    encrypted_api_token: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class Layout(Base):
    __tablename__ = "layouts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    grid_configuration: Mapped[dict] = mapped_column(JSON, nullable=False)
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Optional schedule – when set, the layout is only served within this window.
    # schedule_start / schedule_end are "HH:MM" 24-hour strings (local server time).
    # schedule_days is a JSON list of weekday integers (0=Monday … 6=Sunday).
    schedule_start: Mapped[str | None] = mapped_column(String(5), nullable=True)
    schedule_end: Mapped[str | None] = mapped_column(String(5), nullable=True)
    schedule_days: Mapped[list | None] = mapped_column(JSON, nullable=True)
    devices: Mapped[list["Device"]] = relationship(back_populates="current_layout")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="offline")
    current_layout_id: Mapped[int | None] = mapped_column(ForeignKey("layouts.id"), nullable=True)
    last_ping: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    pairing_code: Mapped[str | None] = mapped_column(String(4), nullable=True)
    pairing_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)

    current_layout: Mapped[Layout | None] = relationship(back_populates="devices")


class LayoutAssignment(Base):
    __tablename__ = "layout_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    layout_id: Mapped[int] = mapped_column(ForeignKey("layouts.id"), nullable=False)
    zone_id: Mapped[str] = mapped_column(String(100), nullable=False)
    source_id: Mapped[int] = mapped_column(ForeignKey("content_sources.id"), nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False, default="")
    assignment_type: Mapped[str] = mapped_column(String(20), nullable=False, default="redirect")  # "embed" or "redirect"

    layout: Mapped[Layout] = relationship()
    source: Mapped[ContentSource] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    actor: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    details: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)