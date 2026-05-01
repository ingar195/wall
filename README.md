# DisplayManager V1

DisplayManager V1 is a centralized digital signage system for securely displaying authenticated dashboards on unattended screens. It uses a FastAPI proxy to inject service-account or API tokens server-side so credentials never land on the kiosk device.

## Features

- FastAPI backend with server-rendered Jinja2 admin UI
- SQLite persistence via SQLAlchemy
- Encrypted content-source tokens using Fernet
- Device pairing with 4-digit codes
- WebSocket hub for live refresh and layout updates
- Reverse proxy for token-backed content such as Grafana
- Kiosk page with pixel shifting and reconnect/reload resilience

## Quick Start

1. Create a Python 3.11+ virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Copy `.env.example` to `.env` and set `ENCRYPTION_KEY`.
4. Start the server:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

5. Open `http://localhost:8000/admin`.

## Environment Variables

- `ENCRYPTION_KEY`: Fernet key used to encrypt source tokens at rest
- `DB_PATH`: SQLAlchemy database URL, defaults to `sqlite:///./display_manager.db`
- `HOST`: default bind host for local scripts, defaults to `0.0.0.0`
- `PORT`: default bind port for local scripts, defaults to `8000`
- `ADMIN_PASSWORD`: password for the built-in admin login page
- `SESSION_SECRET`: secret used to sign the admin session cookie

Generate a key with:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Kiosk Launch Command

```bash
chromium-browser --kiosk --incognito --disable-infobars --disable-session-crashed-bubble --overscroll-history-navigation=0 http://<server-ip>:8000/display/<device_id>
```

## Electron Client (Native Multi-Window)

The optional Electron client runs each layout zone as a native browser window (no iframe), which is useful for sites that block framing.

1. Go to the Electron folder:

```bash
cd electron
```

2. Install dependencies:

```bash
npm install
```

3. Edit `config.json`:

```json
{
	"server": "https://test.angry.fish",
	"kiosk": true,
	"displayMode": "primary",
	"displayIds": [],
	"resolution": {
		"x": null,
		"y": null,
		"width": null,
		"height": null
	}
}
```

4. Start Electron:

```bash
npm start
```

### Electron Display Settings

- `displayMode`: `primary` or `span`
- `displayIds`: optional monitor IDs to target; empty list means all detected displays for `span`
- `resolution.x` and `resolution.y`: optional pixel offset for the top-left corner of the window canvas; set to `null` to use the detected display origin
- `resolution.width` and `resolution.height`: optional virtual canvas override; set to `null` to use detected display bounds

Examples:

- Single monitor automatic bounds:

```json
{
	"displayMode": "primary",
	"displayIds": [],
	"resolution": { "x": null, "y": null, "width": null, "height": null }
}
```

- Span multiple monitors using detected total bounds:

```json
{
	"displayMode": "span",
	"displayIds": [],
	"resolution": { "x": null, "y": null, "width": null, "height": null }
}
```

- Span monitors with fixed startup canvas:

```json
{
	"displayMode": "span",
	"displayIds": [],
	"resolution": { "x": 0, "y": 0, "width": 3840, "height": 1080 }
}
```

- Fixed position on a secondary monitor at a specific offset:

```json
{
	"displayMode": "primary",
	"displayIds": [],
	"resolution": { "x": 1920, "y": 0, "width": 1920, "height": 1080 }
}
```

You can also override these with environment variables: `WALL_DISPLAY_MODE`, `WALL_DISPLAY_IDS`, `WALL_X`, `WALL_Y`, `WALL_WIDTH`, `WALL_HEIGHT`.

## Workflow

1. Add a content source in the admin dashboard.
2. Create a layout and assign sources to zones.
3. Open a kiosk at `/display/<device_id>`.
4. If the device is unknown, it will show a 4-digit pairing code.
5. Pair the device in the admin dashboard and assign a layout.

## Admin Access

- The admin UI is protected by a password form at `/admin/login`.
- Change both `ADMIN_PASSWORD` and `SESSION_SECRET` before exposing the service.
- All admin mutations are recorded in the audit log panel.
- Admin POST forms include CSRF tokens and reject invalid submissions with HTTP 403.

## Notes

- The proxy strips `X-Frame-Options` and `Content-Security-Policy` frame restrictions from upstream responses so proxied dashboards can be embedded in local iframes.
- Layout assignment now uses per-zone forms instead of raw JSON pastes.
- SQLite is best run with a single Uvicorn worker. For multi-worker production, move to a server-grade database and migration flow.
- Large uploads, SSO flows, and advanced layout drag-and-drop persistence are still out of scope for this V1 scaffold.