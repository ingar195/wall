from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def csv_env(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_dotenv()


@dataclass(slots=True)
class Settings:
    app_env: str = os.getenv("APP_ENV", "development").strip().lower()
    encryption_key: str = os.getenv("ENCRYPTION_KEY", "")
    db_path: str = os.getenv("DB_PATH", "sqlite:///./display_manager.db")
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))
    admin_password: str = os.getenv("ADMIN_PASSWORD", "change-me")
    session_secret: str = os.getenv("SESSION_SECRET", os.getenv("ENCRYPTION_KEY", "dev-session-secret"))
    trusted_hosts: list[str] = field(default_factory=lambda: csv_env("TRUSTED_HOSTS", "localhost,127.0.0.1"))
    trusted_proxy_ips: list[str] = field(default_factory=lambda: csv_env("TRUSTED_PROXY_IPS", "127.0.0.1,::1"))

    @property
    def is_production(self) -> bool:
        return self.app_env in {"production", "prod"}


settings = Settings()