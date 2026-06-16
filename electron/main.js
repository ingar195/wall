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

const { app, BrowserWindow, globalShortcut, net, screen } = require("electron");
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
    res = await net.fetch(url);
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

function applyWindowDisplayCss(win) {
  const css = `
    html, body {
      background: #000000 !important;
      overflow: hidden !important;
      scrollbar-width: none !important;
    }

    ::-webkit-scrollbar {
      width: 0 !important;
      height: 0 !important;
      display: none !important;
    }
  `;

  const inject = () => {
    win.webContents.insertCSS(css).catch(() => {});
    win.setBackgroundColor("#000000");
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

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWebSocket() {
  if (isQuitting) return;
  try {
    // Include Origin and a browser-like User-Agent so the WebSocket upgrade
    // request passes WAF / Cloudflare bot checks that reject bare Node.js clients.
    wsClient = new WebSocket(WS_URL, {
      headers: {
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
