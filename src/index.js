import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getMotionDebug,
  hasMotionIntent,
  parseMotion,
  parsePatternTrigger
} from "./motionParser.js";
import { HandyController } from "./handyController.js";
import { HandyNativeController } from "./handyNativeController.js";
import {
  buildModeCatalogSnapshot,
  getPatternCycleTargetMs,
  getPatternFrame,
  getPatternStepSpan,
  MODE_DEPTHS,
  MODE_PATTERN_NAMES,
  MODE_STYLES,
  normalizeCatalogStyleName
} from "./modeCatalog.js";

const app = express();
// Allow local browser calls from SillyTavern UI to this local bridge.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});
app.use((req, _res, next) => {
  // Basic request trace for troubleshooting extension connectivity.
  // eslint-disable-next-line no-console
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});
app.use(express.json({ limit: "256kb" }));

const port = Number(process.env.PORT ?? 8787);
const enabled = String(process.env.ENABLE_DEVICE ?? "true").toLowerCase() === "true";
let strictMotionTagRuntime =
  String(process.env.STRICT_MOTION_TAG ?? "true").toLowerCase() === "true";

const buttplugController = new HandyController({
  serverUrl: process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345",
  deviceNameFilter: process.env.DEVICE_NAME_FILTER ?? "handy",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});
const nativeController = new HandyNativeController({
  apiBaseUrl: process.env.HANDY_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy/v2",
  apiBaseUrlV3: process.env.HANDY_V3_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy-rest/v3",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});
const controllers = {
  buttplug: buttplugController,
  "handy-native": nativeController
};
const DEADMAN_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.DEADMAN_TIMEOUT_MS ?? 600000)
);
const FORCE_HAMP_PROTOCOL =
  String(process.env.FORCE_HAMP_PROTOCOL ?? "true").toLowerCase() === "true";
const PARK_ON_START =
  String(process.env.PARK_ON_START ?? "true").toLowerCase() === "true";
const CONFIG_FILE_PATH =
  process.env.CONFIG_PATH
  || path.resolve(process.cwd(), "tavernplug.config.json");
const STATS_FILE_PATH =
  process.env.STATS_PATH
  || path.resolve(process.cwd(), "tavernplug.stats.json");
const TRACKED_STYLES = MODE_STYLES;
const TRACKED_DEPTHS = MODE_DEPTHS;
const TRACKED_PATTERNS = MODE_PATTERN_NAMES;
const TRACKED_MODE_KEYS = TRACKED_STYLES.flatMap((style) => TRACKED_DEPTHS.map((depth) => `${style}/${depth}`));

let ready = false;
const patternState = {
  active: false,
  name: null,
  step: 0,
  intervalHandle: null,
  stopHandle: null,
  frameBusy: false,
  runToken: 0
};
let motionRunToken = 0;
let lastMotionCommandAt = 0;
let motionLikelyActive = false;
let deadmanEngaged = false;
let startupParkPromise = null;
let usageStatsPersistHandle = null;
// Runtime-tunable values exposed via POST /config.
let motionConfig = {
  controllerMode:
    String(process.env.CONTROLLER_MODE ?? "handy-native").toLowerCase() === "handy-native"
      ? "handy-native"
      : "buttplug",
  handyConnectionKey: process.env.HANDY_CONNECTION_KEY ?? "",
  handyApiBaseUrl:
    process.env.HANDY_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy/v2",
  handyV3ApiBaseUrl:
    process.env.HANDY_V3_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy-rest/v3",
  handyV3ApiKey: process.env.HANDY_V3_API_KEY ?? "",
  handyNativeProtocol:
    ["hamp", "hdsp", "hrpp"].includes(
      String(process.env.HANDY_NATIVE_PROTOCOL ?? "hamp").toLowerCase()
    )
      ? String(process.env.HANDY_NATIVE_PROTOCOL ?? "hamp").toLowerCase()
      : "hamp",
  handyNativeBackend:
    String(process.env.HANDY_NATIVE_BACKEND ?? "thehandy").toLowerCase() === "builtin"
      ? "builtin"
      : "thehandy",
  handyNativePositionScale:
    String(process.env.HANDY_NATIVE_POSITION_SCALE ?? "percent").toLowerCase() === "unit"
      ? "unit"
      : "percent",
  handyNativeCommand:
    String(process.env.HANDY_NATIVE_COMMAND ?? "xpt").toLowerCase() === "xat"
      ? "xat"
      : "xpt",
  handyNativeTrace:
    String(process.env.HANDY_NATIVE_TRACE ?? "false").toLowerCase() === "true",
  handyNativeMin: Number(process.env.HANDY_NATIVE_MIN ?? 0.25),
  handyNativeMax: Number(process.env.HANDY_NATIVE_MAX ?? 0.75),
  strokeRange: Number(process.env.STROKE_RANGE ?? 1),
  globalStrokeMin: Number(process.env.GLOBAL_STROKE_MIN ?? 0),
  globalStrokeMax: Number(process.env.GLOBAL_STROKE_MAX ?? 1),
  physicalMin: Number(process.env.PHYSICAL_MIN ?? 0),
  physicalMax: Number(process.env.PHYSICAL_MAX ?? 1),
  invertStroke:
    String(process.env.INVERT_STROKE ?? "false").toLowerCase() === "true",
  speedMin: Number(process.env.SPEED_MIN ?? 0),
  speedMax: Number(process.env.SPEED_MAX ?? 1),
  minimumAllowedStroke: Number(process.env.MINIMUM_ALLOWED_STROKE ?? 0),
  endpointSafetyPadding: Number(process.env.ENDPOINT_SAFETY_PADDING ?? 0.03),
  safeMode: String(process.env.SAFE_MODE ?? "true").toLowerCase() === "true",
  safeMaxSpeed: Number(process.env.SAFE_MAX_SPEED ?? 0.75),
  smoothPatternTransitions:
    String(process.env.SMOOTH_PATTERN_TRANSITIONS ?? "false").toLowerCase() === "true",
  holdUntilNextCommand:
    String(process.env.HOLD_UNTIL_NEXT_COMMAND ?? "false").toLowerCase() === "true",
  stopPreviousOnNewMotion:
    String(process.env.STOP_PREVIOUS_ON_NEW_MOTION ?? "true").toLowerCase() === "true",
  strictMotionTag: strictMotionTagRuntime
};

function createCounter(keys = []) {
  const counter = {};
  for (const key of keys) {
    counter[key] = 0;
  }
  return counter;
}

function createEmptyUsageStats() {
  return {
    schemaVersion: 1,
    sessionStartedAt: new Date().toISOString(),
    updatedAt: null,
    totalMotionCalls: 0,
    totalPatternStarts: 0,
    totalPatternFrames: 0,
    styleCalls: createCounter(TRACKED_STYLES),
    depthCalls: createCounter(TRACKED_DEPTHS),
    modeCalls: createCounter(TRACKED_MODE_KEYS),
    patternStarts: createCounter(TRACKED_PATTERNS),
    patternFrameCalls: createCounter(TRACKED_PATTERNS),
    sourceCalls: {}
  };
}

let usageStats = createEmptyUsageStats();

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function normalizeStyleName(raw) {
  return normalizeCatalogStyleName(raw);
}

function normalizeDepthName(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizePatternName(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeUsageSource(raw, fallback = "unknown") {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_");
  return normalized || fallback;
}

function buildModeKey(style, depth) {
  return `${style}/${depth}`;
}

function incrementCounter(counter, key, amount = 1) {
  if (!key) return;
  counter[key] = (Number(counter[key]) || 0) + amount;
}

function mergeCounter(target, source, allowedKeys = null) {
  if (!source || typeof source !== "object") return;
  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  for (const [key, value] of Object.entries(source)) {
    if (allowed && !allowed.has(key)) continue;
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) continue;
    target[key] = Math.round(count);
  }
}

function sanitizeUsageStats(input) {
  const next = createEmptyUsageStats();
  if (!input || typeof input !== "object") return next;
  if (typeof input.sessionStartedAt === "string" && input.sessionStartedAt.trim()) {
    next.sessionStartedAt = input.sessionStartedAt;
  }
  if (typeof input.updatedAt === "string" && input.updatedAt.trim()) {
    next.updatedAt = input.updatedAt;
  }
  next.totalMotionCalls = Math.max(0, Math.round(Number(input.totalMotionCalls) || 0));
  next.totalPatternStarts = Math.max(0, Math.round(Number(input.totalPatternStarts) || 0));
  next.totalPatternFrames = Math.max(0, Math.round(Number(input.totalPatternFrames) || 0));
  mergeCounter(next.styleCalls, input.styleCalls, TRACKED_STYLES);
  mergeCounter(next.depthCalls, input.depthCalls, TRACKED_DEPTHS);
  mergeCounter(next.modeCalls, input.modeCalls, TRACKED_MODE_KEYS);
  mergeCounter(next.patternStarts, input.patternStarts, TRACKED_PATTERNS);
  mergeCounter(next.patternFrameCalls, input.patternFrameCalls, TRACKED_PATTERNS);
  mergeCounter(next.sourceCalls, input.sourceCalls);
  return next;
}

async function loadUsageStats() {
  try {
    const raw = await fs.readFile(STATS_FILE_PATH, "utf8");
    usageStats = sanitizeUsageStats(JSON.parse(raw));
    // eslint-disable-next-line no-console
    console.log(`[stats] loaded usage stats from ${STATS_FILE_PATH}`);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    // eslint-disable-next-line no-console
    console.warn("[stats] failed to load usage stats:", error);
  }
}

async function persistUsageStats() {
  try {
    await fs.writeFile(
      STATS_FILE_PATH,
      `${JSON.stringify(usageStats, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[stats] failed to persist usage stats:", error);
  }
}

function schedulePersistUsageStats() {
  if (usageStatsPersistHandle) return;
  usageStatsPersistHandle = setTimeout(() => {
    usageStatsPersistHandle = null;
    void persistUsageStats();
  }, 750);
}

function touchUsageStats() {
  usageStats.updatedAt = new Date().toISOString();
  schedulePersistUsageStats();
}

function trackMotionUsage(motion, rawSource = "api_motion") {
  const style = normalizeStyleName(motion?.style);
  const depth = normalizeDepthName(motion?.depth);
  const source = normalizeUsageSource(rawSource, "api_motion");
  usageStats.totalMotionCalls += 1;
  if (TRACKED_STYLES.includes(style)) {
    incrementCounter(usageStats.styleCalls, style);
  }
  if (TRACKED_DEPTHS.includes(depth)) {
    incrementCounter(usageStats.depthCalls, depth);
  }
  if (TRACKED_STYLES.includes(style) && TRACKED_DEPTHS.includes(depth)) {
    incrementCounter(usageStats.modeCalls, buildModeKey(style, depth));
  }
  incrementCounter(usageStats.sourceCalls, source);
  touchUsageStats();
}

function trackPatternStart(patternTrigger, rawSource = "chat_pattern") {
  const pattern = normalizePatternName(patternTrigger?.pattern);
  const source = normalizeUsageSource(rawSource, "chat_pattern");
  usageStats.totalPatternStarts += 1;
  if (TRACKED_PATTERNS.includes(pattern)) {
    incrementCounter(usageStats.patternStarts, pattern);
  }
  incrementCounter(usageStats.sourceCalls, source);
  touchUsageStats();
}

function trackPatternFrameUsage(patternName, motion) {
  const pattern = normalizePatternName(patternName);
  const style = normalizeStyleName(motion?.style);
  const depth = normalizeDepthName(motion?.depth);
  usageStats.totalPatternFrames += 1;
  if (TRACKED_PATTERNS.includes(pattern)) {
    incrementCounter(usageStats.patternFrameCalls, pattern);
  }
  if (TRACKED_STYLES.includes(style)) {
    incrementCounter(usageStats.styleCalls, style);
  }
  if (TRACKED_DEPTHS.includes(depth)) {
    incrementCounter(usageStats.depthCalls, depth);
  }
  if (TRACKED_STYLES.includes(style) && TRACKED_DEPTHS.includes(depth)) {
    incrementCounter(usageStats.modeCalls, buildModeKey(style, depth));
  }
  touchUsageStats();
}

function summarizeCounter(counter, knownKeys = null, limit = 3) {
  const keys = knownKeys ?? Object.keys(counter ?? {});
  const entries = keys.map((key) => ({
    key,
    count: Math.max(0, Math.round(Number(counter?.[key]) || 0))
  }));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const used = entries
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const leastUsed = [...used]
    .sort((a, b) => a.count - b.count || a.key.localeCompare(b.key));
  const withPct = (entry) => ({
    ...entry,
    pct: total > 0 ? Number(((entry.count / total) * 100).toFixed(1)) : 0
  });
  return {
    total,
    top: used.slice(0, limit).map(withPct),
    least: leastUsed.slice(0, limit).map(withPct),
    unused: entries.filter((entry) => entry.count === 0).map((entry) => entry.key)
  };
}

function buildUsageStatsSummary(stats = usageStats) {
  return {
    modes: summarizeCounter(stats.modeCalls, TRACKED_MODE_KEYS),
    styles: summarizeCounter(stats.styleCalls, TRACKED_STYLES),
    depths: summarizeCounter(stats.depthCalls, TRACKED_DEPTHS),
    patternStarts: summarizeCounter(stats.patternStarts, TRACKED_PATTERNS),
    patternFrames: summarizeCounter(stats.patternFrameCalls, TRACKED_PATTERNS),
    sources: summarizeCounter(stats.sourceCalls)
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return Boolean(value);
}

function getControllerMode(mode) {
  return mode === "handy-native" ? "handy-native" : "buttplug";
}

function getActiveController(config = motionConfig) {
  return controllers[getControllerMode(config.controllerMode)] ?? buttplugController;
}

function sanitizeMotionConfig(input) {
  // Add new user-adjustable variables here and clamp/validate below.
  const next = {
    controllerMode:
      input.controllerMode === undefined
        ? motionConfig.controllerMode
        : getControllerMode(String(input.controllerMode).toLowerCase()),
    handyConnectionKey:
      input.handyConnectionKey === undefined
        ? motionConfig.handyConnectionKey
        : String(input.handyConnectionKey ?? "").trim(),
    handyApiBaseUrl:
      input.handyApiBaseUrl === undefined
        ? motionConfig.handyApiBaseUrl
        : String(input.handyApiBaseUrl ?? "").trim(),
    handyV3ApiBaseUrl:
      input.handyV3ApiBaseUrl === undefined
        ? motionConfig.handyV3ApiBaseUrl
        : String(input.handyV3ApiBaseUrl ?? "").trim(),
    handyV3ApiKey:
      input.handyV3ApiKey === undefined
        ? motionConfig.handyV3ApiKey
        : String(input.handyV3ApiKey ?? "").trim(),
    handyNativeProtocol:
      input.handyNativeProtocol === undefined
        ? motionConfig.handyNativeProtocol
        : String(input.handyNativeProtocol ?? "").trim().toLowerCase(),
    handyNativeBackend:
      input.handyNativeBackend === undefined
        ? motionConfig.handyNativeBackend
        : String(input.handyNativeBackend ?? "").trim().toLowerCase(),
    handyNativePositionScale:
      input.handyNativePositionScale === undefined
        ? motionConfig.handyNativePositionScale
        : String(input.handyNativePositionScale ?? "").trim().toLowerCase(),
    handyNativeCommand:
      input.handyNativeCommand === undefined
        ? motionConfig.handyNativeCommand
        : String(input.handyNativeCommand ?? "").trim().toLowerCase(),
    handyNativeTrace:
      input.handyNativeTrace === undefined
        ? motionConfig.handyNativeTrace
        : parseBoolean(input.handyNativeTrace, motionConfig.handyNativeTrace),
    handyNativeMin:
      input.handyNativeMin === undefined
        ? motionConfig.handyNativeMin
        : Number(input.handyNativeMin),
    handyNativeMax:
      input.handyNativeMax === undefined
        ? motionConfig.handyNativeMax
        : Number(input.handyNativeMax),
    strokeRange:
      input.strokeRange === undefined
        ? motionConfig.strokeRange
        : Number(input.strokeRange),
    globalStrokeMin:
      input.globalStrokeMin === undefined
        ? motionConfig.globalStrokeMin
        : Number(input.globalStrokeMin),
    globalStrokeMax:
      input.globalStrokeMax === undefined
        ? motionConfig.globalStrokeMax
        : Number(input.globalStrokeMax),
    physicalMin:
      input.physicalMin === undefined
        ? motionConfig.physicalMin
        : Number(input.physicalMin),
    physicalMax:
      input.physicalMax === undefined
        ? motionConfig.physicalMax
        : Number(input.physicalMax),
    invertStroke:
      input.invertStroke === undefined
        ? motionConfig.invertStroke
        : parseBoolean(input.invertStroke, motionConfig.invertStroke),
    speedMin:
      input.speedMin === undefined ? motionConfig.speedMin : Number(input.speedMin),
    speedMax:
      input.speedMax === undefined ? motionConfig.speedMax : Number(input.speedMax),
    minimumAllowedStroke:
      input.minimumAllowedStroke === undefined
        ? motionConfig.minimumAllowedStroke
        : Number(input.minimumAllowedStroke),
    endpointSafetyPadding:
      input.endpointSafetyPadding === undefined
        ? motionConfig.endpointSafetyPadding
        : Number(input.endpointSafetyPadding),
    safeMode:
      input.safeMode === undefined
        ? motionConfig.safeMode
        : parseBoolean(input.safeMode, motionConfig.safeMode),
    safeMaxSpeed:
      input.safeMaxSpeed === undefined
        ? motionConfig.safeMaxSpeed
        : Number(input.safeMaxSpeed),
    smoothPatternTransitions:
      input.smoothPatternTransitions === undefined
        ? motionConfig.smoothPatternTransitions
        : parseBoolean(input.smoothPatternTransitions, motionConfig.smoothPatternTransitions),
    holdUntilNextCommand:
      input.holdUntilNextCommand === undefined
        ? motionConfig.holdUntilNextCommand
        : parseBoolean(input.holdUntilNextCommand, motionConfig.holdUntilNextCommand),
    stopPreviousOnNewMotion:
      input.stopPreviousOnNewMotion === undefined
        ? motionConfig.stopPreviousOnNewMotion
        : parseBoolean(input.stopPreviousOnNewMotion, motionConfig.stopPreviousOnNewMotion),
    strictMotionTag:
      input.strictMotionTag === undefined
        ? motionConfig.strictMotionTag
        : parseBoolean(input.strictMotionTag, motionConfig.strictMotionTag)
  };

  if (!Number.isFinite(next.strokeRange)) {
    throw new Error("strokeRange must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.speedMin)) {
    throw new Error("speedMin must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.globalStrokeMin)) {
    throw new Error("globalStrokeMin must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.globalStrokeMax)) {
    throw new Error("globalStrokeMax must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.physicalMin)) {
    throw new Error("physicalMin must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.physicalMax)) {
    throw new Error("physicalMax must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.speedMax)) {
    throw new Error("speedMax must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.minimumAllowedStroke)) {
    throw new Error("minimumAllowedStroke must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.safeMaxSpeed)) {
    throw new Error("safeMaxSpeed must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.endpointSafetyPadding)) {
    throw new Error("endpointSafetyPadding must be a number between 0 and 0.2");
  }
  if (!next.handyApiBaseUrl) {
    throw new Error("handyApiBaseUrl must be a non-empty URL");
  }
  if (!next.handyV3ApiBaseUrl) {
    throw new Error("handyV3ApiBaseUrl must be a non-empty URL");
  }
  if (!["hamp", "hdsp", "hrpp"].includes(next.handyNativeProtocol)) {
    throw new Error("handyNativeProtocol must be 'hamp', 'hdsp' or 'hrpp'");
  }
  if (!["builtin", "thehandy"].includes(next.handyNativeBackend)) {
    throw new Error("handyNativeBackend must be 'builtin' or 'thehandy'");
  }
  if (!["percent", "unit"].includes(next.handyNativePositionScale)) {
    throw new Error("handyNativePositionScale must be 'percent' or 'unit'");
  }
  if (!["xpt", "xat"].includes(next.handyNativeCommand)) {
    throw new Error("handyNativeCommand must be 'xpt' or 'xat'");
  }
  if (!Number.isFinite(next.handyNativeMin)) {
    throw new Error("handyNativeMin must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.handyNativeMax)) {
    throw new Error("handyNativeMax must be a number between 0 and 1");
  }

  next.strokeRange = clamp01(next.strokeRange);
  next.globalStrokeMin = clamp01(next.globalStrokeMin);
  next.globalStrokeMax = clamp01(next.globalStrokeMax);
  next.physicalMin = clamp01(next.physicalMin);
  next.physicalMax = clamp01(next.physicalMax);
  next.speedMin = clamp01(next.speedMin);
  next.speedMax = clamp01(next.speedMax);
  next.minimumAllowedStroke = clamp01(next.minimumAllowedStroke);
  next.endpointSafetyPadding = Math.max(0, Math.min(0.2, next.endpointSafetyPadding));
  next.safeMaxSpeed = Math.min(0.75, clamp01(next.safeMaxSpeed));
  next.controllerMode = getControllerMode(next.controllerMode);
  next.handyNativeProtocol = ["hamp", "hdsp", "hrpp"].includes(next.handyNativeProtocol)
    ? next.handyNativeProtocol
    : "hamp";
  if (FORCE_HAMP_PROTOCOL && next.handyNativeProtocol === "hrpp") {
    next.handyNativeProtocol = "hamp";
  }
  next.handyNativeBackend = next.handyNativeBackend === "builtin" ? "builtin" : "thehandy";
  next.handyNativePositionScale = next.handyNativePositionScale === "unit" ? "unit" : "percent";
  next.handyNativeCommand = next.handyNativeCommand === "xat" ? "xat" : "xpt";
  next.handyNativeMin = clamp01(next.handyNativeMin);
  next.handyNativeMax = clamp01(next.handyNativeMax);
  if (next.handyNativeMax < next.handyNativeMin) {
    const tmp = next.handyNativeMin;
    next.handyNativeMin = next.handyNativeMax;
    next.handyNativeMax = tmp;
  }

  if (next.speedMax < next.speedMin) {
    const tmp = next.speedMin;
    next.speedMin = next.speedMax;
    next.speedMax = tmp;
  }
  if (next.globalStrokeMax < next.globalStrokeMin) {
    const tmp = next.globalStrokeMin;
    next.globalStrokeMin = next.globalStrokeMax;
    next.globalStrokeMax = tmp;
  }
  if (next.physicalMax < next.physicalMin) {
    const tmp = next.physicalMin;
    next.physicalMin = next.physicalMax;
    next.physicalMax = tmp;
  }
  if (next.safeMode) {
    next.speedMin = Math.min(next.speedMin, 0.75);
    next.speedMax = Math.min(next.speedMax, 0.75);
  }

  return next;
}

motionConfig = sanitizeMotionConfig(motionConfig);
nativeController.setApiBaseUrl(motionConfig.handyApiBaseUrl);
nativeController.setApiBaseUrlV3(motionConfig.handyV3ApiBaseUrl);

async function loadPersistedMotionConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const sanitizedPersisted = { ...parsed };
    delete sanitizedPersisted.handyConnectionKey;
    motionConfig = sanitizeMotionConfig({
      ...motionConfig,
      ...sanitizedPersisted
    });
    nativeController.setApiBaseUrl(motionConfig.handyApiBaseUrl);
    nativeController.setApiBaseUrlV3(motionConfig.handyV3ApiBaseUrl);
    strictMotionTagRuntime = motionConfig.strictMotionTag;
    // eslint-disable-next-line no-console
    console.log(`[config] loaded persisted config from ${CONFIG_FILE_PATH}`);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    // eslint-disable-next-line no-console
    console.warn("[config] failed to load persisted config:", error);
  }
}

async function persistMotionConfig() {
  try {
    const persistedConfig = {
      ...motionConfig,
      handyConnectionKey: ""
    };
    await fs.writeFile(
      CONFIG_FILE_PATH,
      `${JSON.stringify(persistedConfig, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[config] failed to persist config:", error);
  }
}

function applySafeModeToMotion(motion, config) {
  if (!config.safeMode) return motion;
  return {
    ...motion,
    // Safe mode only constrains speed and never exceeds 75%.
    speed: Math.min(motion.speed, config.safeMaxSpeed, 0.75)
  };
}

function applyTransientStrokeOverrides(motion, body) {
  const next = { ...motion };
  const rawCumStrokePct = Number(body?.cumStrokePct);
  if (Number.isFinite(rawCumStrokePct)) {
    next.cumStrokePct = Math.max(0, Math.min(100, rawCumStrokePct));
    // eslint-disable-next-line no-console
    console.log(`[motion] cumStrokePct override=${next.cumStrokePct.toFixed(1)}%`);
  }

  const rawSlideMinPct = Number(body?.slideMinPct);
  const rawSlideMaxPct = Number(body?.slideMaxPct);
  if (Number.isFinite(rawSlideMinPct) && Number.isFinite(rawSlideMaxPct)) {
    next.slideMinPct = Math.max(0, Math.min(100, Math.min(rawSlideMinPct, rawSlideMaxPct)));
    next.slideMaxPct = Math.max(0, Math.min(100, Math.max(rawSlideMinPct, rawSlideMaxPct)));
    // eslint-disable-next-line no-console
    console.log(
      `[motion] slide override=${next.slideMinPct.toFixed(1)}%..${next.slideMaxPct.toFixed(1)}%`
    );
  }

  return next;
}

function cancelMotionRunner() {
  motionRunToken += 1;
}

function markMotionCommand() {
  lastMotionCommandAt = Date.now();
  motionLikelyActive = true;
  deadmanEngaged = false;
}

function markMotionStopped() {
  motionLikelyActive = false;
  deadmanEngaged = false;
}

function isIgnoredSystemImagePrompt(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  return normalized.startsWith("[sillytavern system sends a picture that contains:")
    || normalized.startsWith("sillytavern system sends a picture that contains:");
}

function startMotionRunner(runMotion, config) {
  const token = ++motionRunToken;
  const controller = getActiveController(config);

  const loop = async () => {
    if (token !== motionRunToken) return;
    // Keep one continuous linear loop alive until preempted/stopped.
    // This avoids duration-window boundary restarts that cause jitter spikes.
    await controller.runMotion(runMotion, config, {
      stopPreviousOnNewMotion: true,
      holdUntilNextCommand: true,
      stopAtEnd: false,
      smoothTransition: Boolean(config.smoothPatternTransitions)
    });
  };

  void loop().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[motion] runner error:", error);
  });
}

function logMotionDebug(text) {
  const debug = getMotionDebug(text, { strictTag: strictMotionTagRuntime });
  if (debug.mode === "strict") {
    // eslint-disable-next-line no-console
    console.log(
      `[detect] mode=strict hasTag=${Boolean(debug.hasTag)} style=${debug.style ?? "-"} depth=${debug.depth ?? "-"} speed=${debug.speed ?? "-"} pattern=${debug.pattern ?? "-"}`
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[detect] mode=relaxed intent=${Boolean(debug.hasIntent)} tier=${debug.tier} style=${debug.inferredStyle} depth=${debug.inferredDepth} pattern=${debug.inferredPattern ?? "-"} boost=${Number(debug.anatomicalBoost ?? 0).toFixed(2)} context=${Number(debug.contextBoost ?? 0)} fasterDeeper=${Boolean(debug.fasterDeeper)}`
  );
}

function nextPatternFrame(name, step) {
  return getPatternFrame(name, step);
}

function stopPatternRunner() {
  patternState.runToken += 1;
  if (patternState.intervalHandle) {
    clearInterval(patternState.intervalHandle);
    patternState.intervalHandle = null;
  }
  if (patternState.stopHandle) {
    clearTimeout(patternState.stopHandle);
    patternState.stopHandle = null;
  }
  patternState.active = false;
  patternState.name = null;
  patternState.step = 0;
  patternState.frameBusy = false;
}

async function runPatternFrame(trigger, step) {
  const controller = getActiveController(motionConfig);
  const frame = nextPatternFrame(trigger.pattern, step);
  const overrideSpeedPct = Number(frame.speedPct);
  const rawMotion = {
    ...frame,
    style: frame.style,
    depth: frame.depth,
    speed: Number.isFinite(overrideSpeedPct)
      ? Math.max(0, Math.min(100, overrideSpeedPct)) / 100
      : trigger.speed,
    durationMs: Math.max(
      300,
      Math.round(trigger.intervalMs * 0.95 * Math.max(0.25, Number(frame.durationMultiplier) || 1))
    )
  };
  const runMotion = applySafeModeToMotion(rawMotion, motionConfig);
  // eslint-disable-next-line no-console
  console.log(
    `[pattern] frame pattern=${trigger.pattern} step=${step} style=${runMotion.style} depth=${runMotion.depth} speed=${runMotion.speed.toFixed(3)} durationMs=${runMotion.durationMs}`
  );
  await controller.runMotion(runMotion, motionConfig, {
    stopPreviousOnNewMotion: true,
    holdUntilNextCommand: true,
    smoothTransition: Boolean(motionConfig.smoothPatternTransitions)
  });
  trackPatternFrameUsage(trigger.pattern, runMotion);
}

async function startPatternRunner(trigger, options = {}) {
  stopPatternRunner();
  const runToken = ++patternState.runToken;
  patternState.active = true;
  patternState.name = trigger.pattern;
  patternState.step = 0;

  const intervalMs = Math.max(300, Math.min(15000, Math.round(trigger.intervalMs)));
  const totalDurationMs = Math.max(1000, Math.round(trigger.durationMs));
  const repeatWindows = options.repeatWindows ?? true;

  const tick = async () => {
    if (!patternState.active || patternState.runToken !== runToken || patternState.frameBusy) return;
    const step = patternState.step;
    patternState.frameBusy = true;
    try {
      await runPatternFrame(trigger, step);
    } finally {
      if (patternState.runToken === runToken) {
        patternState.frameBusy = false;
      }
    }
  };

  await tick();
  if (!patternState.active || patternState.runToken !== runToken) return;
  patternState.intervalHandle = setInterval(() => {
    if (!patternState.active || patternState.runToken !== runToken) return;
    patternState.step += 1;
    void tick();
  }, intervalMs);

  const scheduleWindowReset = () => {
    patternState.stopHandle = setTimeout(() => {
      if (!patternState.active || patternState.runToken !== runToken) return;
      if (!repeatWindows) {
        stopPatternRunner();
        const fallbackMotion = applySafeModeToMotion(
          {
            style: "steady",
            depth: "middle",
            speed: Math.max(0.35, Math.min(0.65, trigger.speed ?? 0.55)),
            durationMs: 5000
          },
          motionConfig
        );
        cancelMotionRunner();
        startMotionRunner(fallbackMotion, {
          ...motionConfig,
          holdUntilNextCommand: true
        });
        // eslint-disable-next-line no-console
        console.log(`[pattern] auto ${trigger.pattern} ended; fallback to steady/middle hold`);
        return;
      }
      patternState.step = 0;
      // eslint-disable-next-line no-console
      console.log("[pattern] duration window elapsed; restarting pattern cycle");
      scheduleWindowReset();
    }, totalDurationMs);
  };
  scheduleWindowReset();
}

async function ensureReady() {
  if (!enabled) return;
  if (startupParkPromise) {
    await startupParkPromise.catch(() => {});
  }
  const controller = getActiveController(motionConfig);
  const status = controller.getStatus?.() ?? {};
  if (ready && status.connected === true) return;
  // eslint-disable-next-line no-console
  console.log(`[device] connecting (${motionConfig.controllerMode})...`);
  await controller.connectWithRetry(motionConfig);
  ready = true;
  // eslint-disable-next-line no-console
  console.log(`[device] connected (${motionConfig.controllerMode})`);
}

app.get("/health", (_req, res) => {
  const activeController = getActiveController(motionConfig);
  const activeStatus = activeController.getStatus();
  const hspState = activeStatus?.hspState ?? null;
  res.json({
    ok: true,
    deviceEnabled: enabled,
    ready,
    controllerMode: motionConfig.controllerMode,
    handyNativeProtocol: motionConfig.handyNativeProtocol,
    deadmanTimeoutMs: DEADMAN_TIMEOUT_MS,
    motionLikelyActive,
    lastMotionCommandAt,
    controller: activeStatus,
    hspState,
    controllers: {
      buttplug: buttplugController.getStatus(),
      "handy-native": nativeController.getStatus()
    }
  });
});

app.get("/config", (_req, res) => {
  res.json({ ok: true, config: { ...motionConfig, strictMotionTag: strictMotionTagRuntime } });
});

app.get("/catalog", (_req, res) => {
  res.json({
    ok: true,
    catalog: buildModeCatalogSnapshot()
  });
});

app.get("/stats", (_req, res) => {
  res.json({
    ok: true,
    stats: usageStats,
    summary: buildUsageStatsSummary()
  });
});

app.post("/stats/reset", async (_req, res) => {
  usageStats = createEmptyUsageStats();
  await persistUsageStats();
  return res.json({
    ok: true,
    stats: usageStats,
    summary: buildUsageStatsSummary()
  });
});

app.post("/config", (req, res) => {
  try {
    // Central place where extension UI values are validated before use.
    const previousMode = motionConfig.controllerMode;
    const previousApiUrl = motionConfig.handyApiBaseUrl;
    const previousApiUrlV3 = motionConfig.handyV3ApiBaseUrl;
    const previousV3ApiKey = motionConfig.handyV3ApiKey;
    const previousConnectionKey = motionConfig.handyConnectionKey;
    const previousProtocol = motionConfig.handyNativeProtocol;
    const previousScale = motionConfig.handyNativePositionScale;
    const previousCommand = motionConfig.handyNativeCommand;
    const previousNativeMin = motionConfig.handyNativeMin;
    const previousNativeMax = motionConfig.handyNativeMax;
    motionConfig = sanitizeMotionConfig(req.body ?? {});
    nativeController.setApiBaseUrl(motionConfig.handyApiBaseUrl);
    nativeController.setApiBaseUrlV3(motionConfig.handyV3ApiBaseUrl);
    strictMotionTagRuntime = motionConfig.strictMotionTag;
    if (
      previousMode !== motionConfig.controllerMode
      || previousApiUrl !== motionConfig.handyApiBaseUrl
      || previousApiUrlV3 !== motionConfig.handyV3ApiBaseUrl
      || previousV3ApiKey !== motionConfig.handyV3ApiKey
      || previousConnectionKey !== motionConfig.handyConnectionKey
      || previousProtocol !== motionConfig.handyNativeProtocol
      || previousScale !== motionConfig.handyNativePositionScale
      || previousCommand !== motionConfig.handyNativeCommand
      || previousNativeMin !== motionConfig.handyNativeMin
      || previousNativeMax !== motionConfig.handyNativeMax
    ) {
      ready = false;
    }
    void persistMotionConfig();
    return res.json({ ok: true, config: motionConfig });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/connect", async (_req, res) => {
  try {
    const controller = getActiveController(motionConfig);
    await ensureReady();
    return res.json({
      ok: true,
      mode: motionConfig.controllerMode,
      controller: controller.getStatus()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      mode: motionConfig.controllerMode,
      error: error instanceof Error ? error.message : String(error),
      controller: getActiveController(motionConfig).getStatus()
    });
  }
});

app.post("/emergency-stop", async (_req, res) => {
  try {
    const controller = getActiveController(motionConfig);
    stopPatternRunner();
    cancelMotionRunner();
    await ensureReady();
    if (enabled) {
      await controller.stopNow({ cancelPending: true }, motionConfig);
    }
    markMotionStopped();
    return res.json({ ok: true, simulated: !enabled });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/park-hold", async (_req, res) => {
  try {
    const controller = getActiveController(motionConfig);
    stopPatternRunner();
    cancelMotionRunner();
    await ensureReady();
    if (enabled) {
      await controller.parkAtZero(motionConfig);
    }
    markMotionStopped();
    return res.json({ ok: true, simulated: !enabled, parked: true, position: 0 });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/motion", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const usageSource = normalizeUsageSource(req.body?.usageSource, "api_motion");
  if (!text.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }
  if (isIgnoredSystemImagePrompt(text)) {
    // eslint-disable-next-line no-console
    console.log("[motion] ignored system image prompt");
    return res.json({
      accepted: true,
      simulated: !enabled,
      skipped: true,
      reason: "Ignored system image prompt",
      continuedPreviousMotion: true
    });
  }
  logMotionDebug(text);
  const controller = getActiveController(motionConfig);

  let patternTrigger = null;
  try {
    patternTrigger = parsePatternTrigger(text, { strictTag: strictMotionTagRuntime });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[pattern] error=${JSON.stringify(message)} text=${JSON.stringify(text)}`);
    return res.status(400).json({
      accepted: false,
      error: message
    });
  }

  if (patternTrigger) {
    cancelMotionRunner();
    if (patternTrigger.stop) {
      try {
        stopPatternRunner();
        await controller.stopNow({ cancelPending: true }, motionConfig);
        markMotionStopped();
        // eslint-disable-next-line no-console
        console.log("[pattern] stop trigger received");
        return res.json({
          accepted: true,
          simulated: !enabled,
          pattern: { stop: true }
        });
      } catch (error) {
        return res.status(500).json({
          accepted: false,
          pattern: { stop: true },
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      const trackedPatternTrigger = {
        ...patternTrigger,
        usageSource
      };
      await ensureReady();
      if (enabled) {
        // eslint-disable-next-line no-console
        console.log(
          `[pattern] start name=${patternTrigger.pattern} auto=${Boolean(patternTrigger.auto)} speed=${patternTrigger.speed.toFixed(3)} intervalMs=${patternTrigger.intervalMs} durationMs=${patternTrigger.durationMs}`
        );
        await startPatternRunner(trackedPatternTrigger, {
          repeatWindows: !Boolean(patternTrigger.auto)
        });
        markMotionCommand();
      }
      trackPatternStart(patternTrigger, usageSource);
      return res.json({
        accepted: true,
        simulated: !enabled,
        pattern: patternTrigger
      });
    } catch (error) {
      return res.status(500).json({
        accepted: false,
        pattern: patternTrigger,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!hasMotionIntent(text, { strictTag: strictMotionTagRuntime })) {
    return res.json({
      accepted: true,
      simulated: !enabled,
      skipped: true,
      reason: "No motion intent detected",
      continuedPreviousMotion: true
    });
  }

  let motion;
  try {
    // Toggle strict tag requirements via STRICT_MOTION_TAG env.
    motion = parseMotion(text, { strictTag: strictMotionTagRuntime });
    // eslint-disable-next-line no-console
    console.log(
      `[parse] style=${motion.style} depth=${motion.depth} speed=${motion.speed.toFixed(3)} durationMs=${motion.durationMs} text=${JSON.stringify(text)}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[parse] error=${JSON.stringify(message)} text=${JSON.stringify(text)}`);
    return res.status(400).json({
      accepted: false,
      error: message
    });
  }

  motion = applyTransientStrokeOverrides(motion, req.body);

  try {
    await ensureReady();
    stopPatternRunner();
    cancelMotionRunner();
    const runMotion = applySafeModeToMotion(motion, motionConfig);
    if (enabled) {
      // eslint-disable-next-line no-console
      console.log(
        "[motion] running",
        runMotion,
        `safeMode=${motionConfig.safeMode} holdUntilNextCommand=${motionConfig.holdUntilNextCommand}`
      );
      startMotionRunner(runMotion, motionConfig);
      markMotionCommand();
    }
    trackMotionUsage(runMotion, usageSource);

    return res.json({
      accepted: true,
      simulated: !enabled,
      motion: runMotion
    });
  } catch (error) {
    return res.status(500).json({
      accepted: false,
      motion,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/preview-motion", (req, res) => {
  const text = String(req.body?.text ?? "");
  if (!text.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }
  if (isIgnoredSystemImagePrompt(text)) {
    return res.json({
      accepted: true,
      simulated: true,
      skipped: true,
      reason: "Ignored system image prompt",
      strictMotionTag: strictMotionTagRuntime
    });
  }
  logMotionDebug(text);

  let patternTrigger = null;
  try {
    patternTrigger = parsePatternTrigger(text, { strictTag: strictMotionTagRuntime });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(
      `[preview] pattern error=${JSON.stringify(message)} text=${JSON.stringify(text)}`
    );
    return res.status(400).json({
      accepted: false,
      error: message
    });
  }

  if (patternTrigger) {
    if (patternTrigger.stop) {
      return res.json({
        accepted: true,
        simulated: true,
        strictMotionTag: strictMotionTagRuntime,
        pattern: { stop: true }
      });
    }

    return res.json({
      accepted: true,
      simulated: true,
      strictMotionTag: strictMotionTagRuntime,
      pattern: patternTrigger,
      configSnapshot: {
        controllerMode: motionConfig.controllerMode,
        handyNativeProtocol: motionConfig.handyNativeProtocol,
        handyApiBaseUrl: motionConfig.handyApiBaseUrl,
        handyNativePositionScale: motionConfig.handyNativePositionScale,
        handyNativeCommand: motionConfig.handyNativeCommand,
        handyNativeTrace: motionConfig.handyNativeTrace,
        handyNativeMin: motionConfig.handyNativeMin,
        handyNativeMax: motionConfig.handyNativeMax,
        handyConnectionKey: motionConfig.handyConnectionKey ? "[set]" : "",
        speedMin: motionConfig.speedMin,
        speedMax: motionConfig.speedMax,
        strokeRange: motionConfig.strokeRange,
        globalStrokeMin: motionConfig.globalStrokeMin,
        globalStrokeMax: motionConfig.globalStrokeMax,
        physicalMin: motionConfig.physicalMin,
        physicalMax: motionConfig.physicalMax,
        invertStroke: motionConfig.invertStroke,
        minimumAllowedStroke: motionConfig.minimumAllowedStroke,
        endpointSafetyPadding: motionConfig.endpointSafetyPadding,
        safeMode: motionConfig.safeMode,
        safeMaxSpeed: motionConfig.safeMaxSpeed,
        holdUntilNextCommand: motionConfig.holdUntilNextCommand
      }
    });
  }

  let motion;
  try {
    motion = parseMotion(text, { strictTag: strictMotionTagRuntime });
    // eslint-disable-next-line no-console
    console.log(
      `[preview] style=${motion.style} depth=${motion.depth} speed=${motion.speed.toFixed(3)} durationMs=${motion.durationMs} text=${JSON.stringify(text)}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(
      `[preview] error=${JSON.stringify(message)} text=${JSON.stringify(text)}`
    );
    return res.status(400).json({
      accepted: false,
      error: message
    });
  }

  const runMotion = applySafeModeToMotion(motion, motionConfig);
  return res.json({
    accepted: true,
    simulated: true,
    strictMotionTag: strictMotionTagRuntime,
    motion: runMotion,
    configSnapshot: {
      controllerMode: motionConfig.controllerMode,
      handyNativeProtocol: motionConfig.handyNativeProtocol,
      handyApiBaseUrl: motionConfig.handyApiBaseUrl,
      handyNativePositionScale: motionConfig.handyNativePositionScale,
      handyNativeCommand: motionConfig.handyNativeCommand,
      handyNativeTrace: motionConfig.handyNativeTrace,
      handyNativeMin: motionConfig.handyNativeMin,
      handyNativeMax: motionConfig.handyNativeMax,
      handyConnectionKey: motionConfig.handyConnectionKey ? "[set]" : "",
      speedMin: motionConfig.speedMin,
      speedMax: motionConfig.speedMax,
      strokeRange: motionConfig.strokeRange,
      globalStrokeMin: motionConfig.globalStrokeMin,
      globalStrokeMax: motionConfig.globalStrokeMax,
      physicalMin: motionConfig.physicalMin,
      physicalMax: motionConfig.physicalMax,
      invertStroke: motionConfig.invertStroke,
      minimumAllowedStroke: motionConfig.minimumAllowedStroke,
      endpointSafetyPadding: motionConfig.endpointSafetyPadding,
      safeMode: motionConfig.safeMode,
      safeMaxSpeed: motionConfig.safeMaxSpeed,
      holdUntilNextCommand: motionConfig.holdUntilNextCommand
    }
  });
});

await loadPersistedMotionConfig();
await loadUsageStats();

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`TavernPlug listening on http://127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(
    `[config] ENABLE_DEVICE=${enabled} CONTROLLER_MODE=${motionConfig.controllerMode} HANDY_NATIVE_PROTOCOL=${motionConfig.handyNativeProtocol} BUTTPLUG_WS_URL=${process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345"} HANDY_API_BASE_URL=${motionConfig.handyApiBaseUrl}`
  );

  if (enabled && PARK_ON_START) {
    startupParkPromise = (async () => {
      try {
        const controller = getActiveController(motionConfig);
        await controller.connectWithRetry(motionConfig);
        ready = true;
        await controller.parkAtZero(motionConfig);
        markMotionStopped();
        // eslint-disable-next-line no-console
        console.log("[startup] parked at 0");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[startup] park-at-0 failed:", error);
      } finally {
        startupParkPromise = null;
      }
    })();
  }
});

setInterval(async () => {
  if (!enabled || !motionLikelyActive || deadmanEngaged) return;
  if (!lastMotionCommandAt) return;
  const ageMs = Date.now() - lastMotionCommandAt;
  if (ageMs < DEADMAN_TIMEOUT_MS) return;

  deadmanEngaged = true;
  try {
    const controller = getActiveController(motionConfig);
    // eslint-disable-next-line no-console
    console.warn(`[safety] deadman timeout (${ageMs}ms); stopping and parking.`);
    stopPatternRunner();
    cancelMotionRunner();
    await controller.stopNow({ cancelPending: true }, motionConfig);
    await controller.parkAtZero(motionConfig);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[safety] deadman handler error:", error);
  } finally {
    markMotionStopped();
  }
}, 1000);

if (String(process.env.STDIN_MODE ?? "false").toLowerCase() === "true") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    const text = chunk.trim();
    if (!text) return;
    if (isIgnoredSystemImagePrompt(text)) {
      // eslint-disable-next-line no-console
      console.log("[stdin] ignored system image prompt");
      return;
    }

    let patternTrigger = null;
    try {
      patternTrigger = parsePatternTrigger(text, { strictTag: strictMotionTagRuntime });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "pattern parse error:",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    if (patternTrigger) {
      if (patternTrigger.stop) {
        const controller = getActiveController(motionConfig);
        // eslint-disable-next-line no-console
        console.log("pattern parsed:", patternTrigger);
        stopPatternRunner();
        try {
          await controller.stopNow({ cancelPending: true }, motionConfig);
        } catch (_error) {
          // Best-effort stop.
        }
        return;
      }

      // eslint-disable-next-line no-console
      console.log("pattern parsed:", patternTrigger);
      if (!enabled) return;

      try {
        await ensureReady();
        await startPatternRunner(patternTrigger);
        trackPatternStart(patternTrigger, "stdin_pattern");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("pattern error:", error);
      }
      return;
    }

    let motion;
  try {
    motion = parseMotion(text, { strictTag: strictMotionTagRuntime });
    motion = applyTransientStrokeOverrides(motion, req.body);
  } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "parse error:",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    // eslint-disable-next-line no-console
    console.log("parsed:", motion);

    if (!enabled) return;

    try {
      await ensureReady();
      stopPatternRunner();
      cancelMotionRunner();
      const runMotion = applySafeModeToMotion(motion, motionConfig);
      startMotionRunner(runMotion, motionConfig);
      trackMotionUsage(runMotion, "stdin_motion");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("device error:", error);
    }
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
  // Keep bridge alive if websocket layer throws outside request handlers.
  // eslint-disable-next-line no-console
  console.error("[fatal] uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[fatal] unhandledRejection:", reason);
});
