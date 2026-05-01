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
 */

const { app, BrowserWindow, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");

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
    path.join(__dirname, "config.json"),
  ];
  if (process.resourcesPath) {
    locations.unshift(path.join(process.resourcesPath, "config.json"));
  }
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        return JSON.parse(fs.readFileSync(loc, "utf8"));
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
const PIXEL_SHIFT_INTERVAL_MS = 30 * 1000;
const PIXEL_SHIFT_STEPS = [
  { x: 0, y: 0 },
  { x: PIXEL_SHIFT_PX, y: 0 },
  { x: 0, y: PIXEL_SHIFT_PX },
  { x: PIXEL_SHIFT_PX, y: PIXEL_SHIFT_PX },
];

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, BrowserWindow>} */
let zoneWindows = new Map();
/** @type {Map<string, {x:number,y:number,width:number,height:number}>} */
let zoneBaseBounds = new Map();
let pairingWindow = null;
let wsClient = null;
let pollTimer = null;
let pixelShiftTimer = null;
let pixelShiftStepIndex = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
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

function clampBoundsToDisplay(bounds, displayBounds) {
  const minX = displayBounds.x;
  const minY = displayBounds.y;
  const maxX = displayBounds.x + displayBounds.width - bounds.width;
  const maxY = displayBounds.y + displayBounds.height - bounds.height;
  return {
    x: Math.max(minX, Math.min(bounds.x, maxX)),
    y: Math.max(minY, Math.min(bounds.y, maxY)),
    width: bounds.width,
    height: bounds.height,
  };
}

// ── Window management ─────────────────────────────────────────────────────────

function closePairingWindow() {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    pairingWindow.close();
  }
  pairingWindow = null;
}

function closeZoneWindows() {
  for (const win of zoneWindows.values()) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  zoneWindows.clear();
  zoneBaseBounds.clear();
}

function applyPixelShiftToWindows() {
  const step = PIXEL_SHIFT_STEPS[pixelShiftStepIndex];
  const displayBounds = screen.getPrimaryDisplay().bounds;
  for (const [zoneId, win] of zoneWindows.entries()) {
    if (!win || win.isDestroyed()) continue;
    const base = zoneBaseBounds.get(zoneId);
    if (!base) continue;
    const shifted = clampBoundsToDisplay(
      {
        x: base.x + step.x,
        y: base.y + step.y,
        width: base.width,
        height: base.height,
      },
      displayBounds
    );
    win.setBounds(shifted, false);
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
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  pairingWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    kiosk: WALL_KIOSK,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  pairingWindow.on("closed", () => {
    pairingWindow = null;
  });
  return pairingWindow;
}

function showPairingScreen() {
  closeZoneWindows();
  const win = ensurePairingWindow();
  win.loadURL(`${SERVER_BASE}/display/${encodeURIComponent(DEVICE_ID)}`);
}

function applyLayout(data) {
  closePairingWindow();

  const { layout, zones } = data;
  const displayBounds = screen.getPrimaryDisplay().bounds;
  const nextIds = new Set();

  for (const zone of zones) {
    if (!zone.url) continue;
    const zoneId = String(zone.id);
    nextIds.add(zoneId);

    const bounds = gridToPixelBounds(zone, layout.columns, layout.rows, displayBounds);
    zoneBaseBounds.set(zoneId, bounds);
    let win = zoneWindows.get(zoneId);
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        fullscreen: false,
        kiosk: false,
        movable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: "#000000",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          allowRunningInsecureContent: true,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.on("closed", () => {
        zoneWindows.delete(zoneId);
      });
      zoneWindows.set(zoneId, win);
    }

    const step = PIXEL_SHIFT_STEPS[pixelShiftStepIndex];
    const shifted = clampBoundsToDisplay(
      {
        x: bounds.x + step.x,
        y: bounds.y + step.y,
        width: bounds.width,
        height: bounds.height,
      },
      displayBounds
    );
    win.setBounds(shifted, false);
    const currentUrl = win.webContents.getURL();
    if (currentUrl !== zone.url) {
      win.loadURL(zone.url);
    }
    if (!win.isVisible()) {
      win.showInactive();
    }
  }

  for (const [existingId, existingWindow] of zoneWindows.entries()) {
    if (!nextIds.has(existingId)) {
      zoneBaseBounds.delete(existingId);
      if (!existingWindow.isDestroyed()) {
        existingWindow.close();
      }
      zoneWindows.delete(existingId);
    }
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWebSocket() {
  try {
    const WebSocket = require("ws");
    wsClient = new WebSocket(WS_URL);

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
      console.log("[WS] disconnected — reconnecting in 5 s");
      clearInterval(wsClient._pingInterval);
      setTimeout(connectWebSocket, 5_000);
    });

    wsClient.on("error", (err) => {
      console.error("[WS] error:", err.message);
    });
  } catch (err) {
    console.error("[WS] failed to create WebSocket:", err.message);
    setTimeout(connectWebSocket, 10_000);
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
    } else {
      clearTimeout(pollTimer);
      applyLayout(data);
    }
  } catch (err) {
    console.error("[WALL] Failed to fetch layout:", err.message);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadLayout, 10_000);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  globalShortcut.register("Escape", () => app.quit());
  globalShortcut.register("Control+Q", () => app.quit());

  startPixelShiftLoop();
  loadLayout();
  connectWebSocket();
});

app.on("will-quit", () => {
  if (pixelShiftTimer) {
    clearInterval(pixelShiftTimer);
    pixelShiftTimer = null;
  }
  globalShortcut.unregisterAll();
  closePairingWindow();
  closeZoneWindows();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
