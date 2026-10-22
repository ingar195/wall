"use strict";

/**
 * Wall Display — Electron main process
 *
 * Architecture
 * ─────────────
 * One native BrowserWindow is created per zone.
 * Each zone window is frameless and positioned by layout grid coordinates.
 * This avoids iframe/frame-ancestor limitations entirely and gives each zone
 * a full Chromium instance.
 *
 * Configuration (env vars or command-line args)
 * ─────────────────────────────────────────────
 *   WALL_SERVER   Base URL of the FastAPI server, e.g. http://192.168.1.10:8000
 *   WALL_DEVICE   Device ID string (auto-generated UUID stored in userData if absent)
 *   WALL_DISPLAY_MODE  primary|span (span = union of selected displays)
 *   WALL_DISPLAY_IDS   Comma-separated Electron display IDs (optional)
 *   WALL_X / WALL_Y  Optional virtual canvas origin override
 *   WALL_WIDTH / WALL_HEIGHT  Optional virtual canvas size override
 *   WALL_PIXEL_SHIFT_INTERVAL_MS  Pixel shift interval in milliseconds
 */

const { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, Menu, net, screen, session } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Config is resolved from (highest priority first):
 *  1. Environment variables  WALL_SERVER, WALL_DEVICE, WALL_KIOSK
 *  2. config.json next to main.js (dev) or in process.resourcesPath (packaged)
 *  3. Hard-coded defaults
 *
 * config.json example:
 *   { "server": "http://192.168.1.10:8000", "kiosk": true }
 */
function loadConfig() {
  const locations = [
    path.join(process.cwd(), "config.json"),
    path.join(__dirname, "config.json"),
    path.join(path.dirname(process.execPath), "config.json"),
  ];
  if (process.resourcesPath) {
    locations.unshift(path.join(process.resourcesPath, "config.json"));
  }
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        const parsed = JSON.parse(fs.readFileSync(loc, "utf8"));
        parsed.__loadedFrom = loc;
        return parsed;
      }
    } catch (_) {}
  }
  return {};
}

const _cfg = loadConfig();
const SERVER_BASE = (process.env.WALL_SERVER || _cfg.server || "http://localhost:8000").replace(/\/$/, "");
const WALL_KIOSK  = process.env.WALL_KIOSK !== undefined
  ? process.env.WALL_KIOSK !== "0"
  : (_cfg.kiosk !== undefined ? Boolean(_cfg.kiosk) : true);
const WALL_DISPLAY_MODE = String(process.env.WALL_DISPLAY_MODE || _cfg.displayMode || "primary").toLowerCase();
const WALL_DISPLAY_IDS = (() => {
  const raw = process.env.WALL_DISPLAY_IDS || _cfg.displayIds;
  if (Array.isArray(raw)) {
    return raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
  }
  return [];
})();

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const WALL_X = parseIntOrNull(process.env.WALL_X || (_cfg.resolution && _cfg.resolution.x));
const WALL_Y = parseIntOrNull(process.env.WALL_Y || (_cfg.resolution && _cfg.resolution.y));
const WALL_WIDTH = parsePositiveInt(process.env.WALL_WIDTH || (_cfg.resolution && _cfg.resolution.width));
const WALL_HEIGHT = parsePositiveInt(process.env.WALL_HEIGHT || (_cfg.resolution && _cfg.resolution.height));
const PIXEL_SHIFT_INTERVAL_MS = parsePositiveInt(process.env.WALL_PIXEL_SHIFT_INTERVAL_MS || _cfg.pixelShiftIntervalMs) || 30 * 1000;

function getDeviceId() {
  const envId = process.env.WALL_DEVICE || _cfg.device;
  if (envId) return envId;

  const idPath = path.join(app.getPath("userData"), "device_id.txt");
  if (fs.existsSync(idPath)) {
    const saved = fs.readFileSync(idPath, "utf8").trim();
    if (saved) return saved;
  }
  // Generate a new UUID-style device ID
  const { randomUUID } = require("crypto");
  const id = randomUUID();
  fs.mkdirSync(path.dirname(idPath), { recursive: true });
  fs.writeFileSync(idPath, id, "utf8");
  return id;
}

const DEVICE_ID = getDeviceId();

/**
 * Per-device secret (trust-on-first-use on the server): sent with every request so knowing the
 * device id alone is not enough to impersonate this screen. Generated once, kept in userData.
 * Override with WALL_SECRET / config "secret". Admin can "Reset secret" if it is ever lost.
 */
function getDeviceSecret() {
  const fromEnv = process.env.WALL_SECRET || _cfg.secret;
  if (fromEnv) return String(fromEnv);
  const secretPath = path.join(app.getPath("userData"), "device_secret.txt");
  try {
    const saved = fs.readFileSync(secretPath, "utf8").trim();
    if (saved) return saved;
  } catch (_) {}
  const secret = require("crypto").randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, secret, { encoding: "utf8", mode: 0o600 });
  return secret;
}

const DEVICE_SECRET = getDeviceSecret();
const AUTH_HEADERS = { "X-Device-Id": DEVICE_ID, "X-Device-Secret": DEVICE_SECRET };
const API_URL = `${SERVER_BASE}/api/device/${encodeURIComponent(DEVICE_ID)}`;
const WS_URL = SERVER_BASE.replace(/^http/, "ws") + `/ws/device/${encodeURIComponent(DEVICE_ID)}`;
const PIXEL_SHIFT_PX = 20;
const PIXEL_SHIFT_STEPS = [
  { x: 0, y: 0 },
  { x: PIXEL_SHIFT_PX, y: 0 },
  { x: 0, y: PIXEL_SHIFT_PX },
  { x: PIXEL_SHIFT_PX, y: PIXEL_SHIFT_PX },
];

// ── State ─────────────────────────────────────────────────────────────────────

let isQuitting = false;
/** @type {Map<string, BrowserWindow>} */
let zoneWindows = new Map();
let backgroundWindow = null;
let pairingWindow = null;
let wsClient = null;
let pollTimer = null;
let pixelShiftTimer = null;
let pixelShiftStepIndex = 0;
let lastLayoutData = null;
let displaySettleTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Use Electron's Chromium-backed net.fetch so requests share the same TLS
// fingerprint and User-Agent as the BrowserWindow content.  Node's http module
// presents a different JA3 fingerprint that Cloudflare and other WAFs can block.
async function fetchJSON(url) {
  let res;
  try {
    res = await net.fetch(url, { headers: AUTH_HEADERS });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (res.status === 403) {
    throw new Error(
      `HTTP 403 Forbidden — server or reverse proxy rejected the request. ` +
      `Check TRUSTED_HOSTS on the server and any WAF/Cloudflare rules.`
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from server`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const preview = (await res.text()).slice(0, 120);
    throw new Error(
      `Server returned ${contentType || "unknown content-type"} instead of JSON. ` +
      `Is the server URL correct? Got: ${preview}`
    );
  }

  return res.json();
}

/**
 * Convert grid coordinates to pixel bounds on the active display.
 * Zone grid: x/y are 0-based column/row indices; w/h are column/row spans.
 * Bounds are absolute screen coordinates for BrowserWindow positioning.
 */
function gridToPixelBounds(zone, columns, rows, displayBounds) {
  const { x: ox, y: oy, width, height } = displayBounds;
  const cellW = width / columns;
  const cellH = height / rows;
  return {
    x: Math.round(ox + zone.x * cellW),
    y: Math.round(oy + zone.y * cellH),
    width: Math.max(100, Math.round(zone.w * cellW)),
    height: Math.max(100, Math.round(zone.h * cellH)),
  };
}

/**
 * Log the raw display list and flag overlapping bounds. Overlapping bounds
 * almost always mean the X11/Wayland session has the outputs in
 * mirror/clone mode rather than side-by-side extend mode — in that case the
 * union math in getTargetDisplayBounds() produces a canvas that doesn't
 * match physical reality, and zones meant for the "second" monitor end up
 * positioned on top of the first monitor's content instead of beside it.
 */
function logDisplayDiagnostics() {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  console.log(`[WALL] Detected ${displays.length} display(s):`);
  for (const d of displays) {
    console.log(
      `  id=${d.id}${d.id === primaryId ? " (primary)" : ""} ` +
      `bounds=${JSON.stringify(d.bounds)} scaleFactor=${d.scaleFactor} rotation=${d.rotation}`
    );
  }
  for (let i = 0; i < displays.length; i++) {
    for (let j = i + 1; j < displays.length; j++) {
      const a = displays[i].bounds;
      const b = displays[j].bounds;
      const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (overlapX > 0 && overlapY > 0) {
        console.warn(
          `[WALL] WARNING: displays ${displays[i].id} and ${displays[j].id} overlap by ${overlapX}x${overlapY}px. ` +
          `This usually means the outputs are in mirror/clone mode instead of side-by-side extend mode. ` +
          `Run 'xrandr --query' (X11) or 'wlr-randr' (Wayland) on the Pi to see output names, then set them ` +
          `to extend, e.g.: xrandr --output HDMI-2 --right-of HDMI-1 --auto. ` +
          `Zones will overlap/misplace until the outputs are arranged side by side.`
        );
      }
    }
  }
}

function getTargetDisplayBounds() {
  const allDisplays = screen.getAllDisplays();
  const selected = WALL_DISPLAY_IDS.length
    ? allDisplays.filter((d) => WALL_DISPLAY_IDS.includes(Number(d.id)))
    : allDisplays;
  const candidates = selected.length ? selected : allDisplays;

  let displaySet;
  if (WALL_DISPLAY_MODE === "span" || WALL_DISPLAY_MODE === "all" || WALL_DISPLAY_MODE === "multi") {
    displaySet = candidates;
  } else {
    displaySet = [screen.getPrimaryDisplay()];
  }

  const minX = Math.min(...displaySet.map((d) => d.bounds.x));
  const minY = Math.min(...displaySet.map((d) => d.bounds.y));
  const maxX = Math.max(...displaySet.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displaySet.map((d) => d.bounds.y + d.bounds.height));

  const unionWidth = maxX - minX;
  const unionHeight = maxY - minY;
  return {
    x: WALL_X !== null ? WALL_X : minX,
    y: WALL_Y !== null ? WALL_Y : minY,
    width: WALL_WIDTH || unionWidth,
    height: WALL_HEIGHT || unionHeight,
  };
}

// The browser's own (native) context menu, like Chrome shows. While it is open it is an OS popup above
// our windows, so remote clicks/keys go to the OS (not into the page) until it closes.
let contextMenuOpen = false;

function attachContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const wc = win.webContents;
    const items = [
      { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "Reload", click: () => wc.reload() },
      { type: "separator" },
    ];
    if (params.linkURL) items.push({ label: "Copy link address", click: () => clipboard.writeText(params.linkURL) });
    if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" });
    else if (params.selectionText) items.push({ role: "copy" });
    items.push({ role: "selectAll" });
    contextMenuOpen = true;
    const release = () => { contextMenuOpen = false; };
    setTimeout(release, 20_000); // safety: never leave input stuck in OS mode
    Menu.buildFromTemplate(items).popup({ window: win, x: params.x, y: params.y, callback: release });
  });
}

function applyWindowDisplayCss(win) {
  attachContextMenu(win);
  const css = `
    html, body {
      background: #000000 !important;
      overflow: hidden !important;
      scrollbar-width: none !important;
    }

    /* Zone URL points straight at a video/image file: Chromium shows it tiny; fill the zone. */
    body > video:only-child, body > img:only-child {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      object-fit: contain !important;
    }

    video::-webkit-media-controls,
    video::-webkit-media-controls-enclosure,
    video::-webkit-media-controls-panel,
    video::-webkit-media-controls-overlay-play-button {
      display: none !important;
      -webkit-appearance: none !important;
    }
    video { cursor: none !important; }

    ::-webkit-scrollbar {
      width: 0 !important;
      height: 0 !important;
      display: none !important;
    }
  `;

  const inject = () => {
    win.webContents.insertCSS(css).catch(() => {});
    win.setBackgroundColor("#000000");
    // Zone URL is a bare video file: loop it forever (signage), keep it playing.
    win.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('body > video:only-child');` +
        ` if (v) { v.loop = true; v.controls = false; v.play().catch(() => {}); } })()`
      )
      .catch(() => {});
    applyContentShift(win);
  };

  win.webContents.on("did-finish-load", inject);
  // dom-ready fires before did-finish-load and ensures CSS is applied even
  // for pages that never fully load (e.g. slow content sources).
  win.webContents.on("dom-ready", inject);
}

/**
 * Shift the rendered page content with a CSS transform instead of moving the
 * native OS window. Moving the window itself (via setBounds) caused ghosting
 * on Linux setups without a compositor (e.g. Raspberry Pi OS's default
 * Openbox session) — the X server has nothing to repaint the area the window
 * vacated, so old frames stack up visually over time. Transforming the
 * content inside a window that never moves avoids touching the OS window
 * manager entirely; Chromium repaints the transform internally regardless of
 * GPU/compositor availability.
 */
function applyContentShift(win) {
  if (!win || win.isDestroyed()) return;
  const step = PIXEL_SHIFT_STEPS[pixelShiftStepIndex];
  win.webContents
    .executeJavaScript(
      `document.documentElement.style.setProperty('transition', 'none', 'important');` +
      `document.documentElement.style.setProperty('transform', 'translate(${step.x}px, ${step.y}px)', 'important');`
    )
    .catch(() => {});
}

function createDisplayWindow(bounds, { kiosk = false } = {}) {
  return new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: false,
    kiosk,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    // Must stay non-focusable / hidden from the taskbar: on Linux WMs (e.g.
    // Openbox on Raspberry Pi OS) a "normal" focusable window gets WM-drawn
    // decorations/shadows, which corrupts the kiosk display — each pixel-shift
    // reposition then leaves a shadowed ghost behind since there's no
    // compositor to repaint the vacated area.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
}

// ── Window management ─────────────────────────────────────────────────────────

function closePairingWindow() {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    pairingWindow.close();
  }
  pairingWindow = null;
}

function closeBackgroundWindow() {
  if (backgroundWindow && !backgroundWindow.isDestroyed()) {
    backgroundWindow.close();
  }
  backgroundWindow = null;
}

function closeZoneWindows() {
  for (const win of zoneWindows.values()) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
  zoneWindows.clear();
}

function disposeZoneWindow(zoneId, win) {
  zoneWindows.delete(zoneId);
  if (!win || win.isDestroyed()) {
    return;
  }
  win.hide();
  win.destroy();
}

function disposeAllZoneWindows() {
  for (const [zoneId, win] of zoneWindows.entries()) {
    disposeZoneWindow(zoneId, win);
  }
  zoneWindows.clear();
}

function ensureBackgroundWindow() {
  const bounds = getTargetDisplayBounds();
  if (!backgroundWindow || backgroundWindow.isDestroyed()) {
    backgroundWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      kiosk: false,
      fullscreen: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: "#000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    backgroundWindow.setAlwaysOnTop(true, "normal");
    backgroundWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    backgroundWindow.loadURL("data:text/html,<html><body style='margin:0;background:#000'></body></html>");
    backgroundWindow.on("closed", () => {
      backgroundWindow = null;
    });
  }

  backgroundWindow.setBounds(bounds, false);
  if (!backgroundWindow.isVisible()) {
    backgroundWindow.showInactive();
  }
  return backgroundWindow;
}

function applyPixelShiftToWindows() {
  for (const win of zoneWindows.values()) {
    applyContentShift(win);
  }
}

function startPixelShiftLoop() {
  if (pixelShiftTimer) {
    clearInterval(pixelShiftTimer);
  }
  pixelShiftTimer = setInterval(() => {
    pixelShiftStepIndex = (pixelShiftStepIndex + 1) % PIXEL_SHIFT_STEPS.length;
    applyPixelShiftToWindows();
  }, PIXEL_SHIFT_INTERVAL_MS);
}

function ensurePairingWindow() {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    return pairingWindow;
  }
  const { x, y, width, height } = getTargetDisplayBounds();
  pairingWindow = createDisplayWindow({ x, y, width, height }, { kiosk: WALL_KIOSK });
  pairingWindow.on("closed", () => {
    pairingWindow = null;
  });
  pairingWindow.setAlwaysOnTop(true, "screen-saver");
  applyWindowDisplayCss(pairingWindow);
  return pairingWindow;
}

function showPairingScreen() {
  closeZoneWindows();
  closeBackgroundWindow();
  const win = ensurePairingWindow();
  win.loadURL(`${SERVER_BASE}/display/${encodeURIComponent(DEVICE_ID)}`);
}

/** /splash learns which wall tile this window is: add our device id and the display index (-1 = spans several). */
function withSplashParams(url, bounds) {
  if (!url.includes("/splash")) return url;
  const list = sortedDisplays();
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const i = list.findIndex((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height);
  const spans = i < 0 || bounds.width > list[i].bounds.width * 1.05 || bounds.height > list[i].bounds.height * 1.05;
  const u = new URL(url);
  u.searchParams.set("device", DEVICE_ID);
  u.searchParams.set("display", spans ? -1 : i);
  return u.toString();
}

function applyLayout(data) {
  lastLayoutData = data;
  closePairingWindow();
  ensureBackgroundWindow();

  const { layout, zones } = data;
  const displayBounds = getTargetDisplayBounds();
  const nextZones = zones.filter((zone) => zone.url);
  const nextIds = new Set(nextZones.map((zone) => String(zone.id)));

  for (const [existingId, existingWindow] of Array.from(zoneWindows.entries())) {
    if (!nextIds.has(existingId)) {
      disposeZoneWindow(existingId, existingWindow);
    }
  }

  for (const zone of nextZones) {
    const zoneId = String(zone.id);

    const bounds = gridToPixelBounds(zone, layout.columns, layout.rows, displayBounds);
    let win = zoneWindows.get(zoneId);
    if (!win || win.isDestroyed()) {
      win = createDisplayWindow(bounds);
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.on("closed", () => {
        zoneWindows.delete(zoneId);
      });
      applyWindowDisplayCss(win);
      zoneWindows.set(zoneId, win);
    }

    // The window itself never moves once placed — only its content shifts
    // via CSS transform (see applyContentShift) — so bounds only need to be
    // reapplied here when the grid/display layout actually changes.
    win.setBounds(bounds, false);
    const currentUrl = win.webContents.getURL();
    if (currentUrl !== zone.url) {
      win.loadURL(zone.url);
    }
    if (!win.isVisible()) {
      win.showInactive();
    }
  }
}

/**
 * Recompute display bounds and reposition whatever is currently on screen.
 * Linux multi-monitor arrangement (xrandr/wlr-randr) can finish settling
 * after Electron has already started and taken its first bounds snapshot —
 * particularly on Raspberry Pi where HDMI outputs are detected asynchronously
 * at boot. Without this, zones are sized/positioned against a stale display
 * union and never correct themselves once the real arrangement settles.
 */
function recomputeLayoutForCurrentDisplays() {
  logDisplayDiagnostics();
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    const bounds = getTargetDisplayBounds();
    pairingWindow.setBounds(bounds, false);
  }
  if (lastLayoutData) {
    applyLayout(lastLayoutData);
  } else if (backgroundWindow && !backgroundWindow.isDestroyed()) {
    ensureBackgroundWindow();
  }
}

function scheduleDisplayRecompute() {
  // Debounce — display-added/removed/metrics-changed can fire several times
  // in quick succession while the OS finishes negotiating monitor modes.
  clearTimeout(displaySettleTimer);
  displaySettleTimer = setTimeout(recomputeLayoutForCurrentDisplays, 1_000);
}

// ── Wall view: screenshots + remote input ─────────────────────────────────────
// The admin wall page sends {action:"capture", ms} every couple of seconds while
// someone is watching; we capture only while that lease is alive.

let captureMs = 2500;
let captureUntil = 0;
let captureRunning = false;
let captureFallbackWarned = false;
let pageCaptureWarned = false;
let wakeCapture = null; // interrupts the capture loop's sleep
const lastFrame = new Map(); // display index -> {hash, at}: skip re-uploading identical frames
const FRAME_KEEPALIVE_MS = 30_000; // ...but still refresh now and then (server restart, new viewer)
let captureFull = null; // display index being viewed fullscreen -> capture it at native resolution

/** After an input, grab a fresh frame soon so the admin sees the effect (and stops re-clicking). */
function nudgeCapture() {
  captureUntil = Math.max(captureUntil, Date.now() + 15_000);
  setTimeout(() => (wakeCapture ? wakeCapture() : captureLoop()), 150);
}

/** Stable display order (left→right, top→bottom) so "display 0" means the same screen everywhere. */
function sortedDisplays() {
  return screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

/**
 * Capture mode: "auto" (default) = desktop capture, falling back to rendering our own zone windows when
 * that comes back black or fails; "screen" = desktop capture only; "page" = zone windows only.
 * Raspberry Pi (X11 via XWayland under a Wayland compositor) typically gives black desktop captures,
 * while capturePage() of our own windows works regardless of the compositor. Override: WALL_CAPTURE.
 */
const CAPTURE_MODE = String(process.env.WALL_CAPTURE || _cfg.capture || "auto").toLowerCase();
let compositorWin = null;

function isBlank(image) {
  const bm = image.toBitmap();
  for (let i = 0; i < bm.length; i += 4 * 97) if (bm[i] | bm[i + 1] | bm[i + 2]) return false;
  return true;
}

/** JPEG of one display built from the zone windows on it (no desktop capture needed). */
async function captureDisplayFromPages(d, size, quality) {
  const wins = Array.from(zoneWindows.values()).filter((w) => {
    if (w.isDestroyed()) return false;
    const b = w.getBounds();
    return b.x < d.bounds.x + d.bounds.width && b.x + b.width > d.bounds.x && b.y < d.bounds.y + d.bounds.height && b.y + b.height > d.bounds.y;
  });
  if (!wins.length) return null;
  const scale = Math.min(size.width / d.bounds.width, size.height / d.bounds.height);
  const outW = Math.round(d.bounds.width * scale), outH = Math.round(d.bounds.height * scale);
  // one window exactly on this display: just that window's pixels
  if (wins.length === 1) {
    const b = wins[0].getBounds();
    if (b.x === d.bounds.x && b.y === d.bounds.y && b.width === d.bounds.width && b.height === d.bounds.height) {
      return (await wins[0].webContents.capturePage()).resize({ width: outW, height: outH }).toJPEG(quality);
    }
  }
  const parts = [];
  for (const w of wins) {
    const b = w.getBounds();
    const img = (await w.webContents.capturePage()).resize({ width: Math.max(1, Math.round(b.width * scale)), height: Math.max(1, Math.round(b.height * scale)) });
    parts.push({ x: Math.round((b.x - d.bounds.x) * scale), y: Math.round((b.y - d.bounds.y) * scale), url: "data:image/jpeg;base64," + img.toJPEG(92).toString("base64") });
  }
  // several windows on one display: stitch them on a canvas in a hidden renderer
  if (!compositorWin || compositorWin.isDestroyed()) {
    compositorWin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await compositorWin.loadURL("data:text/html,<canvas id=c></canvas>");
  }
  const dataUrl = await compositorWin.webContents.executeJavaScript(`(async () => {
    const c = document.getElementById('c'); c.width = ${outW}; c.height = ${outH};
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, ${outW}, ${outH});
    for (const p of ${JSON.stringify(parts)}) {
      const im = new Image(); im.src = p.url; await im.decode(); g.drawImage(im, p.x, p.y);
    }
    return c.toDataURL('image/jpeg', ${quality / 100});
  })()`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function captureLoop() {
  if (captureRunning) return;
  captureRunning = true;
  try {
    while (Date.now() < captureUntil && !isQuitting) {
      const started = Date.now();
      try {
        const displays = sortedDisplays();
        // Fullscreen viewing: native pixels of that one display (only it is uploaded); otherwise 720p of all.
        // captureFull: display index, -1 = all displays at native size, null = normal 720p of all.
        const fullSet = captureFull === -1 ? displays : captureFull !== null && displays[captureFull] ? [displays[captureFull]] : null;
        const full = fullSet !== null;
        const thumbnailSize = full
          ? {
              width: Math.max(...fullSet.map((d) => Math.round(d.bounds.width * d.scaleFactor))),
              height: Math.max(...fullSet.map((d) => Math.round(d.bounds.height * d.scaleFactor))),
            }
          : { width: 1280, height: 720 };
        const quality = full ? 90 : 75;
        let sources = [];
        if (CAPTURE_MODE !== "page") {
          try {
            sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
          } catch (err) {
            if (CAPTURE_MODE === "screen") throw err;
            console.warn("[WALL] desktop capture failed, using page capture:", err.message);
          }
        }
        for (let i = 0; i < displays.length; i++) {
          if (full && !fullSet.includes(displays[i])) continue;
          let src = sources.find((s) => s.display_id === String(displays[i].id));
          if (!src && sources.length) {
            // ponytail: some X11 setups report no display_id; index order may not match left→right order
            if (!captureFallbackWarned) { console.warn("[WALL] capture: no display_id match, falling back to source order"); captureFallbackWarned = true; }
            src = sources[i];
          }
          let jpeg = null, hash = null;
          if (src && (CAPTURE_MODE === "screen" || !isBlank(src.thumbnail))) {
            hash = require("crypto").createHash("md5").update(src.thumbnail.toBitmap()).digest("hex");
            const prev = lastFrame.get(i);
            if (prev && prev.hash === hash + (full ? "f" : "") && Date.now() - prev.at < FRAME_KEEPALIVE_MS) continue; // static screen
            jpeg = src.thumbnail.toJPEG(quality);
          } else if (CAPTURE_MODE !== "screen") {
            if (!pageCaptureWarned) { console.warn("[WALL] desktop capture blank/unavailable: using zone-window capture"); pageCaptureWarned = true; }
            jpeg = await captureDisplayFromPages(displays[i], thumbnailSize, quality);
            if (!jpeg) continue;
            hash = require("crypto").createHash("md5").update(jpeg).digest("hex");
            const prev = lastFrame.get(i);
            if (prev && prev.hash === hash + (full ? "f" : "") && Date.now() - prev.at < FRAME_KEEPALIVE_MS) continue;
          } else {
            continue;
          }
          lastFrame.set(i, { hash: hash + (full ? "f" : ""), at: Date.now() });
          await net.fetch(`${API_URL}/screenshot/${i}`, {
            method: "POST",
            headers: { ...AUTH_HEADERS, "Content-Type": "image/jpeg" },
            body: jpeg,
          });
        }
      } catch (err) {
        console.error("[WALL] capture failed:", err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
      await new Promise((r) => {
        const t = setTimeout(r, Math.max(50, captureMs - (Date.now() - started)));
        wakeCapture = () => { clearTimeout(t); r(); };
      });
      wakeCapture = null;
    }
  } finally {
    captureRunning = false;
  }
}

function onCaptureLease(ms, fullDisplay) {
  captureMs = Math.min(10_000, Math.max(300, Number(ms) || 2500));
  captureFull = Number.isInteger(fullDisplay) ? fullDisplay : null;
  captureUntil = Date.now() + 15_000;
  captureLoop();
}

/**
 * OS-level input on Windows (a real mouse/keyboard event, as if someone sat at the PC).
 * One long-lived PowerShell reads one command per line from stdin, so each input costs ~ms, not a
 * 300 ms process start-up. Restarted automatically if it dies.
 */
const WIN_HEAD =
  "Add-Type -AssemblyName System.Windows.Forms;" +
  "Add-Type -Name M -Namespace W -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' +
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);' +
  '[DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int d,int e);' +
  '[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);' +
  "';[void][W.M]::SetProcessDPIAware()";
let winShell = null;

function winSend(line) {
  if (!winShell || winShell.exitCode !== null) {
    winShell = spawn("powershell", ["-NoProfile", "-NoLogo", "-Command", "-"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    winShell.on("exit", () => { winShell = null; });
    winShell.stdin.on("error", () => {});
    winShell.stdin.write(WIN_HEAD + "\n");
  }
  winShell.stdin.write(line + "\n");
}

function runWindowsInput(msg, px, py) {
  const psq = (t) => String(t).replace(/'/g, "''");
  let body = "";
  if (msg.kind === "click") {
    const [down, up] = msg.button === "right" ? [8, 16] : [2, 4];
    body = `[void][W.M]::SetCursorPos(${px},${py});Start-Sleep -Milliseconds 30;[W.M]::mouse_event(${down},0,0,0,0);[W.M]::mouse_event(${up},0,0,0,0)`;
  } else if (msg.kind === "scroll") {
    body = `[void][W.M]::SetCursorPos(${px},${py});[W.M]::mouse_event(2048,0,0,${Math.round(-msg.dy)},0)`;
  } else if (msg.kind === "text") {
    const escaped = msg.text.replace(/[+^%~(){}[\]]/g, "{$&}");
    body = `[System.Windows.Forms.SendKeys]::SendWait('${psq(escaped)}')`;
  } else if (msg.kind === "key") {
    const map = { Enter: "{ENTER}", Escape: "{ESC}", Tab: "{TAB}", Backspace: "{BS}", Up: "{UP}", Down: "{DOWN}", Left: "{LEFT}", Right: "{RIGHT}", Delete: "{DEL}" };
    if (!map[msg.key]) return;
    body = `[System.Windows.Forms.SendKeys]::SendWait('${map[msg.key]}')`;
  } else {
    return;
  }
  winSend(body);
}

let lastInputWin = null; // zone window that received the last click; keys/text go there

function runXdotool(...args) {
  if (process.platform !== "linux") return;
  execFile("xdotool", args, (err) => err && console.error("[WALL] xdotool:", err.message));
}

/**
 * Inject a click/scroll/key/text from the admin wall page.
 * Zone windows get Chromium input events (works in-page, no OS focus needed).
 * Anything else (e.g. a native popup over the wall) falls back to xdotool on Linux.
 * ponytail: no OS-level fallback on Windows; add SendInput via PowerShell if needed.
 */
function injectInput(msg) {
  if (msg.kind === "key" && msg.key === "Super") {
    // OS-level Windows/Super key (Start menu etc.) — never meaningful inside a web page.
    // Our zone windows sit at "screen-saver" level and would hide the Start menu, so
    // drop them to normal level for a while, then restore.
    const wallWins = [...zoneWindows.values(), backgroundWindow].filter((w) => w && !w.isDestroyed());
    wallWins.forEach((w) => w.setAlwaysOnTop(false));
    setTimeout(() => wallWins.forEach((w) => !w.isDestroyed() && w.setAlwaysOnTop(true, w === backgroundWindow ? "normal" : "screen-saver")), 15_000);
    if (process.platform === "win32") {
      winSend("[W.M]::keybd_event(0x5B,0,0,0);[W.M]::keybd_event(0x5B,0,2,0)");
    } else {
      runXdotool("key", "super");
    }
    return;
  }
  const d = sortedDisplays()[msg.display];
  if (!d) return;
  const gx = Math.round(d.bounds.x + msg.x * d.bounds.width);
  const gy = Math.round(d.bounds.y + msg.y * d.bounds.height);

  let target = null;
  if (msg.kind === "click" || msg.kind === "scroll") {
    target = Array.from(zoneWindows.values()).find((w) => {
      if (w.isDestroyed()) return false;
      const b = w.getBounds();
      return gx >= b.x && gx < b.x + b.width && gy >= b.y && gy < b.y + b.height;
    }) || null;
    if (msg.kind === "click") lastInputWin = target;
  } else {
    target = lastInputWin && !lastInputWin.isDestroyed() ? lastInputWin : null;
  }

  if (contextMenuOpen) target = null; // menu is an OS popup: send input to the OS

  if (target) {
    const wc = target.webContents;
    const b = target.getBounds();
    // The pixel shift is a CSS transform: hit-testing follows it, and the screenshot shows the shifted
    // content, so window coordinates == screenshot coordinates. (Subtracting the shift made clicks miss.)
    const lx = gx - b.x, ly = gy - b.y;
    if (msg.kind === "click") {
      wc.focus(); // without this the first clicks only hover/focus; typed text then goes nowhere
      wc.sendInputEvent({ type: "mouseMove", x: lx, y: ly });
      setTimeout(() => {
        if (wc.isDestroyed()) return;
        wc.sendInputEvent({ type: "mouseDown", x: lx, y: ly, button: msg.button, clickCount: 1 });
        setTimeout(() => !wc.isDestroyed() && wc.sendInputEvent({ type: "mouseUp", x: lx, y: ly, button: msg.button, clickCount: 1 }), 40);
      }, 40);
    } else if (msg.kind === "scroll") {
      wc.sendInputEvent({ type: "mouseWheel", x: lx, y: ly, deltaX: 0, deltaY: -msg.dy });
    } else if (msg.kind === "text") {
      wc.focus();
      wc.insertText(msg.text);
    } else if (msg.kind === "key" && msg.key) {
      wc.focus();
      wc.sendInputEvent({ type: "keyDown", keyCode: msg.key });
      wc.sendInputEvent({ type: "keyUp", keyCode: msg.key });
    }
    return;
  }

  const px = Math.round(gx * d.scaleFactor), py = Math.round(gy * d.scaleFactor);
  if (process.platform === "win32") {
    runWindowsInput(msg, px, py);
    return;
  }
  if (msg.kind === "click") {
    runXdotool("mousemove", String(px), String(py), "click", msg.button === "right" ? "3" : "1");
  } else if (msg.kind === "scroll") {
    runXdotool("mousemove", String(px), String(py), "click", msg.dy > 0 ? "5" : "4");
  } else if (msg.kind === "text") {
    runXdotool("type", "--delay", "20", "--", msg.text);
  } else if (msg.kind === "key") {
    const map = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "BackSpace", Up: "Up", Down: "Down", Left: "Left", Right: "Right", Delete: "Delete" };
    if (map[msg.key]) runXdotool("key", map[msg.key]);
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWebSocket() {
  if (isQuitting) return;
  try {
    // Include Origin and a browser-like User-Agent so the WebSocket upgrade
    // request passes WAF / Cloudflare bot checks that reject bare Node.js clients.
    wsClient = new WebSocket(WS_URL, {
      headers: {
        ...AUTH_HEADERS,
        "Origin": SERVER_BASE,
        "User-Agent": `Mozilla/5.0 (X11; Linux ${process.arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36`,
      },
    });

    wsClient.on("open", () => {
      console.log("[WS] connected");
      // Keep-alive ping every 30 s
      wsClient._pingInterval = setInterval(() => {
        if (wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    });

    wsClient.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === "refresh" || msg.action === "new_layout") {
          console.log("[WS] layout change — reloading");
          loadLayout();
        } else if (msg.action === "capture") {
          onCaptureLease(msg.ms, msg.full ? msg.display : null);
        } else if (msg.action === "input") {
          injectInput(msg);
          nudgeCapture();
        } else if (msg.type === "pong") {
          // no-op
        }
      } catch (_) {}
    });

    wsClient.on("close", () => {
      clearInterval(wsClient._pingInterval);
      if (!isQuitting) {
        console.log("[WS] disconnected — reconnecting in 5 s");
        setTimeout(connectWebSocket, 5_000);
      }
    });

    wsClient.on("error", (err) => {
      if (err.message.includes("403")) {
        console.error("[WS] 403 Forbidden — server rejected the WebSocket upgrade. " +
          "Check TRUSTED_HOSTS on the server and any reverse proxy configuration.");
      } else {
        console.error("[WS] error:", err.message);
      }
    });
  } catch (err) {
    console.error("[WS] failed to create WebSocket:", err.message);
    if (!isQuitting) setTimeout(connectWebSocket, 10_000);
  }
}

// ── Layout polling ────────────────────────────────────────────────────────────

async function loadLayout() {
  try {
    const data = await fetchJSON(API_URL);
    if (data.status === "unpaired") {
      console.log(`[WALL] Unpaired — pairing code: ${data.pairing_code}`);
      showPairingScreen();
      // Poll every 5 s until paired
      clearTimeout(pollTimer);
      pollTimer = setTimeout(loadLayout, 5_000);
    } else if (data.status === "scheduled_off") {
      console.log("[WALL] Layout is outside its schedule window — showing blank screen.");
      disposeAllZoneWindows();
      closePairingWindow();
      ensureBackgroundWindow();  // keep a full-screen black window visible
      // Poll every 60 s while waiting for the schedule window to open
      clearTimeout(pollTimer);
      pollTimer = setTimeout(loadLayout, 60_000);
    } else {
      clearTimeout(pollTimer);
      applyLayout(data);
      // Re-poll every 60 s so schedule boundaries are detected automatically
      pollTimer = setTimeout(loadLayout, 60_000);
    }
  } catch (err) {
    console.error("[WALL] Failed to fetch layout:", err.message);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadLayout, 10_000);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Zone windows load pages/assets/WebSockets from the server (incl. /proxy); attach the device
  // credentials to every request to *that origin only* (never to third-party hosts).
  const serverUrl = new URL(SERVER_BASE);
  const wsScheme = serverUrl.protocol === "https:" ? "wss" : "ws";
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${serverUrl.protocol}//${serverUrl.host}/*`, `${wsScheme}://${serverUrl.host}/*`] },
    (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, ...AUTH_HEADERS } })
  );
  console.log("[CONFIG] loaded from:", _cfg.__loadedFrom || "defaults");
  console.log("[CONFIG] values:", JSON.stringify({
    server: SERVER_BASE,
    kiosk: WALL_KIOSK,
    displayMode: WALL_DISPLAY_MODE,
    displayIds: WALL_DISPLAY_IDS,
    x: WALL_X,
    y: WALL_Y,
    width: WALL_WIDTH,
    height: WALL_HEIGHT,
    pixelShiftIntervalMs: PIXEL_SHIFT_INTERVAL_MS,
  }));
  logDisplayDiagnostics();
  globalShortcut.register("Escape", () => app.quit());
  globalShortcut.register("Control+Q", () => app.quit());

  // Multi-monitor arrangement can still be settling (xrandr/wlr-randr) when
  // this fires, especially on Raspberry Pi boot. Recompute bounds whenever
  // the OS reports a display change so zones end up correctly sized/placed
  // even if the very first snapshot was taken too early.
  screen.on("display-added", scheduleDisplayRecompute);
  screen.on("display-removed", scheduleDisplayRecompute);
  screen.on("display-metrics-changed", scheduleDisplayRecompute);

  startPixelShiftLoop();
  loadLayout();
  connectWebSocket();
});

app.on("will-quit", () => {
  if (winShell) { winShell.kill(); winShell = null; }
  isQuitting = true;
  if (wsClient) {
    wsClient.terminate();
    wsClient = null;
  }
  if (pixelShiftTimer) {
    clearInterval(pixelShiftTimer);
    pixelShiftTimer = null;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (displaySettleTimer) {
    clearTimeout(displaySettleTimer);
    displaySettleTimer = null;
  }
  screen.removeAllListeners("display-added");
  screen.removeAllListeners("display-removed");
  screen.removeAllListeners("display-metrics-changed");
  globalShortcut.unregisterAll();
  closeBackgroundWindow();
  closePairingWindow();
  closeZoneWindows();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
