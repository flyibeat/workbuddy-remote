import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __sharedDirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE_ROOT_FOLDER_NAME = "WBWorkspaces";
const NO_STORE_CACHE_CONTROL = "no-store";

// 从 workbuddy-remote.config.json 读取单个配置项（读不到/非法则回退）。
// 计划任务无头启动时只能靠这个文件传参，因此后台自动重连相关开关也走这里。
function readConfigRaw() {
  try {
    const configPath = path.resolve(__sharedDirname, "..", "workbuddy-remote.config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function readConfigBoolean(key, fallback) {
  const value = readConfigRaw()?.[key];
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function readConfigPositiveNumber(key, fallback) {
  const value = readConfigRaw()?.[key];
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return fallback;
}

const DEFAULTS = {
  cdpHost: "127.0.0.1",
  cdpPort: 9333,
  listenHost: "127.0.0.1",
  listenPort: 8780,
  passwordHash: process.env.WORKBUDDY_REMOTE_PASSWORD_HASH || "",
  userDataDir: "",
  workbuddyPid: 0,
  openBrowser: false,
  hideWorkBuddyWindowAfterStart: false,
  hideWorkBuddyMenuBar: false,
  logPath: "",
  // 后台自动重连：桌面重启（自动更新、手动开关）后无需任何人工操作，
  // 桥接自己重新挂载到桌面渲染进程。可在 config.json 覆盖。
  autoReconnect: readConfigBoolean("autoReconnect", true),
  reconnectIntervalMs: readConfigPositiveNumber("reconnectIntervalMs", 10000),
  reconnectProbeIntervalMs: readConfigPositiveNumber("reconnectProbeIntervalMs", 60000),
  reconnectTargetTimeoutMs: readConfigPositiveNumber("reconnectTargetTimeoutMs", 5000),
};

// 桌面窗口自绘标题栏（含最小化/最大化/关闭）默认必须保留，
// 只有远程控制台/无头场景才隐藏，因此这里允许从 config 读开关，默认关。
function readConfigMenuBarFlag() {
  return readConfigBoolean("hideWorkBuddyMenuBar", false);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, hideWorkBuddyMenuBar: readConfigMenuBarFlag() };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case "--cdp-host":
        options.cdpHost = next || options.cdpHost;
        i += 1;
        break;
      case "--cdp-port":
        options.cdpPort = Number(next) || options.cdpPort;
        i += 1;
        break;
      case "--host":
        options.listenHost = next || options.listenHost;
        i += 1;
        break;
      case "--port":
        options.listenPort = Number(next) || options.listenPort;
        i += 1;
        break;
      case "--password-hash":
        options.passwordHash = next || "";
        i += 1;
        break;
      case "--user-data-dir":
        options.userDataDir = next || "";
        i += 1;
        break;
      case "--workbuddy-pid":
        options.workbuddyPid = Number(next) || 0;
        i += 1;
        break;
      case "--open-browser":
        options.openBrowser = true;
        break;
      case "--hide-workbuddy-window-after-start":
        options.hideWorkBuddyWindowAfterStart = true;
        break;
      case "--hide-workbuddy-menubar":
        options.hideWorkBuddyMenuBar = true;
        break;
      case "--keep-workbuddy-menubar":
        options.hideWorkBuddyMenuBar = false;
        break;
      case "--no-auto-reconnect":
        options.autoReconnect = false;
        break;
      case "--auto-reconnect":
        options.autoReconnect = true;
        break;
      case "--reconnect-interval-ms":
        options.reconnectIntervalMs = Number(next) || options.reconnectIntervalMs;
        i += 1;
        break;
      case "--log-path":
        options.logPath = next || "";
        i += 1;
        break;
      default:
        break;
    }
  }
  return options;
}

function resolveWorkBuddyExePath() {
  // 允许通过 workbuddy-remote.config.json 的 workbuddyExePath 指定安装位置，
  // 避免依赖外部环境变量（计划任务等无头环境下变量可能丢失）
  let configExePath = "";
  try {
    const configPath = path.resolve(__sharedDirname, "..", "workbuddy-remote.config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof raw?.workbuddyExePath === "string" && raw.workbuddyExePath.trim()) {
      configExePath = raw.workbuddyExePath.trim();
    }
  } catch {}

  const candidates = [
    process.env.WORKBUDDY_EXE_PATH,
    configExePath,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "WorkBuddy.exe"),
    path.join(process.env.ProgramFiles || "", "WorkBuddy", "WorkBuddy.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "WorkBuddy", "WorkBuddy.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return "";
}

function resolveWorkBuddyAsarPath() {
  const envAsar = process.env.WORKBUDDY_APP_ASAR;
  if (envAsar && existsSync(envAsar)) {
    return path.resolve(envAsar);
  }

  const exePath = resolveWorkBuddyExePath();
  if (!exePath) {
    throw new Error("WORKBUDDY_EXE_PATH is not set and WorkBuddy.exe was not found.");
  }

  const asarPath = path.join(path.dirname(exePath), "resources", "app.asar");
  if (!existsSync(asarPath)) {
    throw new Error(`WorkBuddy app.asar was not found: ${asarPath}`);
  }
  return asarPath;
}

function loadWebSocketModule() {
  const require = createRequire(import.meta.url);
  return require("ws");
}

const { WebSocket, WebSocketServer } = loadWebSocketModule();

function json(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    ...headers,
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8", cacheControl = "no-store") {
  const buffer = Buffer.from(String(body), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Content-Length": buffer.byteLength,
  });
  res.end(buffer);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLanUrls(port) {
  const urls = [];
  const seen = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      const url = `http://${entry.address}:${port}/agent-manager/`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

function encodePayloadForTransport(value) {
  if (value instanceof ArrayBuffer) {
    return { kind: "base64", base64: Buffer.from(value).toString("base64") };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      kind: "base64",
      base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  return { kind: "json", value };
}

export {
  DEFAULTS,
  NO_STORE_CACHE_CONTROL,
  WebSocket,
  WebSocketServer,
  WORKSPACE_ROOT_FOLDER_NAME,
  contentTypeFor,
  delay,
  encodePayloadForTransport,
  getLanUrls,
  json,
  parseArgs,
  readJsonBody,
  resolveWorkBuddyAsarPath,
  resolveWorkBuddyExePath,
  text,
};
