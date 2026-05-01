from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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
    encryption_key: str = os.getenv("ENCRYPTION_KEY", "")
    db_path: str = os.getenv("DB_PATH", "sqlite:///./display_manager.db")
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))
    admin_password: str = os.getenv("ADMIN_PASSWORD", "change-me")
    session_secret: str = os.getenv("SESSION_SECRET", os.getenv("ENCRYPTION_KEY", "dev-session-secret"))


settings = Settings()