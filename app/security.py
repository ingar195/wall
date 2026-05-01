from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class EncryptionError(RuntimeError):
    pass


def get_fernet() -> Fernet:
    if not settings.encryption_key:
        raise EncryptionError("ENCRYPTION_KEY is not configured")
    return Fernet(settings.encryption_key.encode("utf-8"))


def encrypt_token(token: str) -> bytes:
    return get_fernet().encrypt(token.encode("utf-8"))


def decrypt_token(encrypted: bytes) -> str:
    try:
        return get_fernet().decrypt(encrypted).decode("utf-8")
    except InvalidToken as exc:
        raise EncryptionError("Unable to decrypt API token") from exc