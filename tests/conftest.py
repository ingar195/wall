"""Shared test environment. Must run before any `app.*` import (settings are read at import time)."""
import os

os.environ["DB_PATH"] = "sqlite:///./_test.db"
os.environ["ENCRYPTION_KEY"] = "a" * 43 + "="
os.environ["DEVICE_AUTH"] = "off"  # device-auth behaviour is covered explicitly in test_device_auth.py
