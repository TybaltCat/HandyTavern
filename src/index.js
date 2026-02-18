import "dotenv/config";
import express from "express";
import { parseMotion } from "./motionParser.js";
import { HandyController } from "./handyController.js";

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
const strictMotionTag =
  String(process.env.STRICT_MOTION_TAG ?? "true").toLowerCase() === "true";

const controller = new HandyController({
  serverUrl: process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345",
  deviceNameFilter: process.env.DEVICE_NAME_FILTER ?? "handy",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});

let ready = false;
// Runtime-tunable values exposed via POST /config.
let motionConfig = {
  handyConnectionKey: process.env.HANDY_CONNECTION_KEY ?? "",
  strokeRange: Number(process.env.STROKE_RANGE ?? 1),
  speedMin: Number(process.env.SPEED_MIN ?? 0),
  speedMax: Number(process.env.SPEED_MAX ?? 1),
  minimumAllowedStroke: Number(process.env.MINIMUM_ALLOWED_STROKE ?? 0),
  safeMode: String(process.env.SAFE_MODE ?? "false").toLowerCase() === "true",
  safeMaxSpeed: Number(process.env.SAFE_MAX_SPEED ?? 0.6),
  safeMaxDurationMs: Number(process.env.SAFE_MAX_DURATION_MS ?? 4000),
  stopPreviousOnNewMotion:
    String(process.env.STOP_PREVIOUS_ON_NEW_MOTION ?? "true").toLowerCase() === "true"
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

function sanitizeMotionConfig(input) {
  // Add new user-adjustable variables here and clamp/validate below.
  const next = {
    handyConnectionKey:
      input.handyConnectionKey === undefined
        ? motionConfig.handyConnectionKey
        : String(input.handyConnectionKey ?? "").trim(),
    strokeRange:
      input.strokeRange === undefined
        ? motionConfig.strokeRange
        : Number(input.strokeRange),
    speedMin:
      input.speedMin === undefined ? motionConfig.speedMin : Number(input.speedMin),
    speedMax:
      input.speedMax === undefined ? motionConfig.speedMax : Number(input.speedMax),
    minimumAllowedStroke:
      input.minimumAllowedStroke === undefined
        ? motionConfig.minimumAllowedStroke
        : Number(input.minimumAllowedStroke),
    safeMode:
      input.safeMode === undefined
        ? motionConfig.safeMode
        : parseBoolean(input.safeMode, motionConfig.safeMode),
    safeMaxSpeed:
      input.safeMaxSpeed === undefined
        ? motionConfig.safeMaxSpeed
        : Number(input.safeMaxSpeed),
    safeMaxDurationMs:
      input.safeMaxDurationMs === undefined
        ? motionConfig.safeMaxDurationMs
        : Number(input.safeMaxDurationMs),
    stopPreviousOnNewMotion:
      input.stopPreviousOnNewMotion === undefined
        ? motionConfig.stopPreviousOnNewMotion
        : parseBoolean(input.stopPreviousOnNewMotion, motionConfig.stopPreviousOnNewMotion)
  };

  if (!Number.isFinite(next.strokeRange)) {
    throw new Error("strokeRange must be a number between 0 and 1");
  }
  if (!Number.isFinite(next.speedMin)) {
    throw new Error("speedMin must be a number between 0 and 1");
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
  if (!Number.isFinite(next.safeMaxDurationMs) || next.safeMaxDurationMs <= 0) {
    throw new Error("safeMaxDurationMs must be a positive number");
  }

  next.strokeRange = clamp01(next.strokeRange);
  next.speedMin = clamp01(next.speedMin);
  next.speedMax = clamp01(next.speedMax);
  next.minimumAllowedStroke = clamp01(next.minimumAllowedStroke);
  next.safeMaxSpeed = clamp01(next.safeMaxSpeed);
  next.safeMaxDurationMs = Math.round(next.safeMaxDurationMs);

  if (next.speedMax < next.speedMin) {
    const tmp = next.speedMin;
    next.speedMin = next.speedMax;
    next.speedMax = tmp;
  }

  return next;
}

motionConfig = sanitizeMotionConfig(motionConfig);

function applySafeModeToMotion(motion, config) {
  if (!config.safeMode) return motion;
  return {
    ...motion,
    speed: Math.min(motion.speed, config.safeMaxSpeed),
    durationMs: Math.min(motion.durationMs, config.safeMaxDurationMs)
  };
}

async function ensureReady() {
  if (ready || !enabled) return;
  // eslint-disable-next-line no-console
  console.log("[device] connecting to buttplug server...");
  await controller.connect();
  ready = true;
  // eslint-disable-next-line no-console
  console.log("[device] connected and scanning started");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, deviceEnabled: enabled, ready });
});

app.get("/config", (_req, res) => {
  res.json({ ok: true, config: motionConfig });
});

app.post("/config", (req, res) => {
  try {
    // Central place where extension UI values are validated before use.
    motionConfig = sanitizeMotionConfig(req.body ?? {});
    return res.json({ ok: true, config: motionConfig });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/emergency-stop", async (_req, res) => {
  try {
    await ensureReady();
    if (enabled) {
      await controller.stopNow({ cancelPending: true });
    }
    return res.json({ ok: true, simulated: !enabled });
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

  let motion;
  try {
    // Toggle strict tag requirements via STRICT_MOTION_TAG env.
    motion = parseMotion(text, { strictTag: strictMotionTag });
  } catch (error) {
    return res.status(400).json({
      accepted: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await ensureReady();
    const runMotion = applySafeModeToMotion(motion, motionConfig);
    if (enabled) {
      // eslint-disable-next-line no-console
      console.log("[motion] running", runMotion, `safeMode=${motionConfig.safeMode}`);
      await controller.runMotion(runMotion, motionConfig, {
        stopPreviousOnNewMotion: motionConfig.stopPreviousOnNewMotion
      });
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

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`TavernPlug listening on http://127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(
    `[config] ENABLE_DEVICE=${enabled} BUTTPLUG_WS_URL=${process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345"} DEVICE_NAME_FILTER=${process.env.DEVICE_NAME_FILTER ?? "handy"}`
  );
});

if (String(process.env.STDIN_MODE ?? "false").toLowerCase() === "true") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    const text = chunk.trim();
    if (!text) return;

    let motion;
    try {
      motion = parseMotion(text, { strictTag: strictMotionTag });
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
      const runMotion = applySafeModeToMotion(motion, motionConfig);
      await controller.runMotion(runMotion, motionConfig, {
        stopPreviousOnNewMotion: motionConfig.stopPreviousOnNewMotion
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("device error:", error);
    }
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
