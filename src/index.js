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
const enabled = String(process.env.ENABLE_DEVICE ?? "false").toLowerCase() === "true";
let strictMotionTagRuntime =
  String(process.env.STRICT_MOTION_TAG ?? "true").toLowerCase() === "true";

const buttplugController = new HandyController({
  serverUrl: process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345",
  deviceNameFilter: process.env.DEVICE_NAME_FILTER ?? "handy",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});
const nativeController = new HandyNativeController({
  apiBaseUrl: process.env.HANDY_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy/v2",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});
const controllers = {
  buttplug: buttplugController,
  "handy-native": nativeController
};
const DEADMAN_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.DEADMAN_TIMEOUT_MS ?? 300000)
);
const PARK_ON_START =
  String(process.env.PARK_ON_START ?? "true").toLowerCase() === "true";
const CONFIG_FILE_PATH =
  process.env.CONFIG_PATH
  || path.resolve(process.cwd(), "tavernplug.config.json");

let ready = false;
const patternState = {
  active: false,
  name: null,
  step: 0,
  intervalHandle: null,
  stopHandle: null,
  frameBusy: false
};
let motionRunToken = 0;
let lastMotionCommandAt = 0;
let motionLikelyActive = false;
let deadmanEngaged = false;
// Runtime-tunable values exposed via POST /config.
let motionConfig = {
  controllerMode:
    String(process.env.CONTROLLER_MODE ?? "handy-native").toLowerCase() === "handy-native"
      ? "handy-native"
      : "buttplug",
  handyConnectionKey: process.env.HANDY_CONNECTION_KEY ?? "",
  handyApiBaseUrl:
    process.env.HANDY_API_BASE_URL ?? "https://www.handyfeeling.com/api/handy/v2",
  handyNativeProtocol:
    ["hamp", "hdsp", "hrpp"].includes(
      String(process.env.HANDY_NATIVE_PROTOCOL ?? "hrpp").toLowerCase()
    )
      ? String(process.env.HANDY_NATIVE_PROTOCOL ?? "hrpp").toLowerCase()
      : "hrpp",
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
  holdUntilNextCommand:
    String(process.env.HOLD_UNTIL_NEXT_COMMAND ?? "false").toLowerCase() === "true",
  stopPreviousOnNewMotion:
    String(process.env.STOP_PREVIOUS_ON_NEW_MOTION ?? "true").toLowerCase() === "true",
  strictMotionTag: strictMotionTagRuntime
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
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
    handyNativeProtocol:
      input.handyNativeProtocol === undefined
        ? motionConfig.handyNativeProtocol
        : String(input.handyNativeProtocol ?? "").trim().toLowerCase(),
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
  if (!["hamp", "hdsp", "hrpp"].includes(next.handyNativeProtocol)) {
    throw new Error("handyNativeProtocol must be 'hamp', 'hdsp' or 'hrpp'");
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
    : "hrpp";
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

async function loadPersistedMotionConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    motionConfig = sanitizeMotionConfig({
      ...motionConfig,
      ...parsed
    });
    nativeController.setApiBaseUrl(motionConfig.handyApiBaseUrl);
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
    await fs.writeFile(
      CONFIG_FILE_PATH,
      `${JSON.stringify(motionConfig, null, 2)}\n`,
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
      stopAtEnd: false
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
  if (name === "wave") {
    const cycle = [
      ["gentle", "middle"],
      ["brisk", "middle"],
      ["normal", "middle"],
      ["hard", "full"],
      ["intense", "deep"],
      ["hard", "full"],
      ["normal", "middle"],
      ["brisk", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "pulse") {
    if (step % 4 === 3) return { style: "intense", depth: "deep" };
    return { style: "normal", depth: "middle" };
  }

  if (name === "ramp") {
    const cycle = ["gentle", "brisk", "normal", "hard", "intense"];
    return { style: cycle[step % cycle.length], depth: "middle" };
  }

  if (name === "tease_hold") {
    const cycle = [
      ["gentle", "tip"],
      ["gentle", "tip"],
      ["gentle", "middle"],
      ["gentle", "tip"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "edging_ramp") {
    const cycle = [
      ["gentle", "middle"],
      ["brisk", "middle"],
      ["normal", "full"],
      ["hard", "full"],
      ["gentle", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "pulse_bursts") {
    const cycle = [
      ["hard", "full"],
      ["intense", "deep"],
      ["hard", "full"],
      ["normal", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "depth_ladder") {
    const cycle = [
      ["normal", "tip"],
      ["normal", "middle"],
      ["hard", "full"],
      ["normal", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "stutter_break") {
    if (step % 5 === 4) return { style: "gentle", depth: "middle" };
    return { style: "hard", depth: "full" };
  }

  if (name === "climax_window") {
    const cycle = [
      ["hard", "full"],
      ["intense", "deep"],
      ["intense", "deep"],
      ["hard", "full"],
      ["brisk", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  const styles = ["gentle", "brisk", "normal", "hard", "intense"];
  const depths = ["tip", "middle", "full", "deep"];
  return {
    style: styles[Math.floor(Math.random() * styles.length)],
    depth: depths[Math.floor(Math.random() * depths.length)]
  };
}

function stopPatternRunner() {
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

async function runPatternFrame(trigger) {
  const controller = getActiveController(motionConfig);
  const frame = nextPatternFrame(trigger.pattern, patternState.step);
  const rawMotion = {
    style: frame.style,
    depth: frame.depth,
    speed: trigger.speed,
    durationMs: Math.max(300, Math.round(trigger.intervalMs * 0.95))
  };
  const runMotion = applySafeModeToMotion(rawMotion, motionConfig);
  // eslint-disable-next-line no-console
  console.log(
    `[pattern] frame pattern=${trigger.pattern} step=${patternState.step} style=${runMotion.style} depth=${runMotion.depth} speed=${runMotion.speed.toFixed(3)} durationMs=${runMotion.durationMs}`
  );
  await controller.runMotion(runMotion, motionConfig, {
    stopPreviousOnNewMotion: true,
    holdUntilNextCommand: false
  });
}

async function startPatternRunner(trigger, options = {}) {
  stopPatternRunner();
  patternState.active = true;
  patternState.name = trigger.pattern;
  patternState.step = 0;

  const intervalMs = Math.max(300, Math.min(15000, Math.round(trigger.intervalMs)));
  const totalDurationMs = Math.max(1000, Math.round(trigger.durationMs));
  const repeatWindows = options.repeatWindows ?? true;

  const tick = async () => {
    if (!patternState.active || patternState.frameBusy) return;
    patternState.frameBusy = true;
    try {
      await runPatternFrame(trigger);
    } finally {
      patternState.frameBusy = false;
    }
  };

  await tick();
  patternState.intervalHandle = setInterval(() => {
    patternState.step += 1;
    void tick();
  }, intervalMs);

  const scheduleWindowReset = () => {
    patternState.stopHandle = setTimeout(() => {
      if (!patternState.active) return;
      if (!repeatWindows) {
        stopPatternRunner();
        const fallbackMotion = applySafeModeToMotion(
          {
            style: "normal",
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
        console.log(`[pattern] auto ${trigger.pattern} ended; fallback to normal/middle hold`);
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
  res.json({
    ok: true,
    deviceEnabled: enabled,
    ready,
    controllerMode: motionConfig.controllerMode,
    deadmanTimeoutMs: DEADMAN_TIMEOUT_MS,
    motionLikelyActive,
    lastMotionCommandAt,
    controller: activeController.getStatus(),
    controllers: {
      buttplug: buttplugController.getStatus(),
      "handy-native": nativeController.getStatus()
    }
  });
});

app.get("/config", (_req, res) => {
  res.json({ ok: true, config: { ...motionConfig, strictMotionTag: strictMotionTagRuntime } });
});

app.post("/config", (req, res) => {
  try {
    // Central place where extension UI values are validated before use.
    const previousMode = motionConfig.controllerMode;
    const previousApiUrl = motionConfig.handyApiBaseUrl;
    const previousConnectionKey = motionConfig.handyConnectionKey;
    const previousProtocol = motionConfig.handyNativeProtocol;
    const previousScale = motionConfig.handyNativePositionScale;
    const previousCommand = motionConfig.handyNativeCommand;
    const previousNativeMin = motionConfig.handyNativeMin;
    const previousNativeMax = motionConfig.handyNativeMax;
    motionConfig = sanitizeMotionConfig(req.body ?? {});
    nativeController.setApiBaseUrl(motionConfig.handyApiBaseUrl);
    strictMotionTagRuntime = motionConfig.strictMotionTag;
    if (
      previousMode !== motionConfig.controllerMode
      || previousApiUrl !== motionConfig.handyApiBaseUrl
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
  if (!text.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }
  logMotionDebug(text);
  const controller = getActiveController(motionConfig);

  let patternTrigger = null;
  try {
    if (!(motionConfig.controllerMode === "handy-native" && motionConfig.handyNativeProtocol === "hamp")) {
      patternTrigger = parsePatternTrigger(text, { strictTag: strictMotionTagRuntime });
    }
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
      await ensureReady();
      if (enabled) {
        // eslint-disable-next-line no-console
        console.log(
          `[pattern] start name=${patternTrigger.pattern} auto=${Boolean(patternTrigger.auto)} speed=${patternTrigger.speed.toFixed(3)} intervalMs=${patternTrigger.intervalMs} durationMs=${patternTrigger.durationMs}`
        );
        await startPatternRunner(patternTrigger, {
          repeatWindows: !Boolean(patternTrigger.auto)
        });
        markMotionCommand();
      }
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
  logMotionDebug(text);

  let patternTrigger = null;
  try {
    if (!(motionConfig.controllerMode === "handy-native" && motionConfig.handyNativeProtocol === "hamp")) {
      patternTrigger = parsePatternTrigger(text, { strictTag: strictMotionTagRuntime });
    }
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

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`TavernPlug listening on http://127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(
    `[config] ENABLE_DEVICE=${enabled} CONTROLLER_MODE=${motionConfig.controllerMode} HANDY_NATIVE_PROTOCOL=${motionConfig.handyNativeProtocol} BUTTPLUG_WS_URL=${process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345"} HANDY_API_BASE_URL=${motionConfig.handyApiBaseUrl}`
  );

  if (enabled && PARK_ON_START) {
    void (async () => {
      try {
        const controller = getActiveController(motionConfig);
        await ensureReady();
        await controller.parkAtZero(motionConfig);
        markMotionStopped();
        // eslint-disable-next-line no-console
        console.log("[startup] parked at 0");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[startup] park-at-0 failed:", error);
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
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("pattern error:", error);
      }
      return;
    }

    let motion;
    try {
      motion = parseMotion(text, { strictTag: strictMotionTagRuntime });
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
