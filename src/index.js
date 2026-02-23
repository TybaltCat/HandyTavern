import "dotenv/config";
import express from "express";
import { getMotionDebug, parseMotion, parsePatternTrigger } from "./motionParser.js";
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
let strictMotionTagRuntime =
  String(process.env.STRICT_MOTION_TAG ?? "true").toLowerCase() === "true";

const controller = new HandyController({
  serverUrl: process.env.BUTTPLUG_WS_URL ?? "ws://127.0.0.1:12345",
  deviceNameFilter: process.env.DEVICE_NAME_FILTER ?? "handy",
  clientName: process.env.CLIENT_NAME ?? "TavernPlug"
});

let ready = false;
const patternState = {
  active: false,
  name: null,
  step: 0,
  intervalHandle: null,
  stopHandle: null,
  frameBusy: false,
  restoreState: null
};
let lastMotionState = null;
// Runtime-tunable values exposed via POST /config.
let motionConfig = {
  handyConnectionKey: process.env.HANDY_CONNECTION_KEY ?? "",
  strokeRange: Number(process.env.STROKE_RANGE ?? 1),
  globalStrokeMin: Number(process.env.GLOBAL_STROKE_MIN ?? 0),
  globalStrokeMax: Number(process.env.GLOBAL_STROKE_MAX ?? 1),
  speedMin: Number(process.env.SPEED_MIN ?? 0),
  speedMax: Number(process.env.SPEED_MAX ?? 1),
  minimumAllowedStroke: Number(process.env.MINIMUM_ALLOWED_STROKE ?? 0),
  safeMode: String(process.env.SAFE_MODE ?? "false").toLowerCase() === "true",
  safeMaxSpeed: Number(process.env.SAFE_MAX_SPEED ?? 0.6),
  safeMaxDurationMs: Number(process.env.SAFE_MAX_DURATION_MS ?? 4000),
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
    globalStrokeMin:
      input.globalStrokeMin === undefined
        ? motionConfig.globalStrokeMin
        : Number(input.globalStrokeMin),
    globalStrokeMax:
      input.globalStrokeMax === undefined
        ? motionConfig.globalStrokeMax
        : Number(input.globalStrokeMax),
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
  next.globalStrokeMin = clamp01(next.globalStrokeMin);
  next.globalStrokeMax = clamp01(next.globalStrokeMax);
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
  if (next.globalStrokeMax < next.globalStrokeMin) {
    const tmp = next.globalStrokeMin;
    next.globalStrokeMin = next.globalStrokeMax;
    next.globalStrokeMax = tmp;
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

function runMotionAsync(runMotion, config) {
  return controller
    .runMotion(runMotion, config, {
      stopPreviousOnNewMotion: config.stopPreviousOnNewMotion,
      holdUntilNextCommand: config.holdUntilNextCommand
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[motion] async error:", error);
    });
}

function snapshotConfig(config) {
  return {
    strokeRange: config.strokeRange,
    globalStrokeMin: config.globalStrokeMin,
    globalStrokeMax: config.globalStrokeMax,
    speedMin: config.speedMin,
    speedMax: config.speedMax,
    minimumAllowedStroke: config.minimumAllowedStroke,
    safeMode: config.safeMode,
    safeMaxSpeed: config.safeMaxSpeed,
    safeMaxDurationMs: config.safeMaxDurationMs,
    holdUntilNextCommand: config.holdUntilNextCommand,
    stopPreviousOnNewMotion: config.stopPreviousOnNewMotion
  };
}

function rememberLastMotionState(motion, config) {
  lastMotionState = {
    motion: { ...motion },
    config: snapshotConfig(config)
  };
}

async function runSavedMotionState(state) {
  if (!state) return;
  const cfg = snapshotConfig(state.config);
  if (cfg.holdUntilNextCommand) {
    void runMotionAsync({ ...state.motion }, cfg);
    return;
  }
  await controller.runMotion({ ...state.motion }, cfg, {
    stopPreviousOnNewMotion: cfg.stopPreviousOnNewMotion,
    holdUntilNextCommand: false
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
    `[detect] mode=relaxed tier=${debug.tier} style=${debug.inferredStyle} depth=${debug.inferredDepth} pattern=${debug.inferredPattern ?? "-"} boost=${Number(debug.anatomicalBoost ?? 0).toFixed(2)} context=${Number(debug.contextBoost ?? 0)} fasterDeeper=${Boolean(debug.fasterDeeper)}`
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
  patternState.restoreState = null;
}

async function runPatternFrame(trigger) {
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

async function startPatternRunner(trigger) {
  const restoreState = lastMotionState
    ? {
        motion: { ...lastMotionState.motion },
        config: snapshotConfig(lastMotionState.config)
      }
    : null;
  stopPatternRunner();
  patternState.active = true;
  patternState.name = trigger.pattern;
  patternState.step = 0;
  patternState.restoreState = restoreState;

  const intervalMs = Math.max(300, Math.min(15000, Math.round(trigger.intervalMs)));
  const totalDurationMs = Math.max(1000, Math.round(trigger.durationMs));

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

  patternState.stopHandle = setTimeout(async () => {
    const stateToRestore = patternState.restoreState
      ? {
          motion: { ...patternState.restoreState.motion },
          config: snapshotConfig(patternState.restoreState.config)
        }
      : null;
    stopPatternRunner();
    try {
      await controller.stopNow({ cancelPending: true });
    } catch (_error) {
      // Best-effort cleanup when pattern window expires.
    }
    if (stateToRestore && enabled) {
      try {
        await runSavedMotionState(stateToRestore);
        // eslint-disable-next-line no-console
        console.log("[pattern] ended; restored previous motion state");
        return;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[pattern] restore failed:", error);
      }
    }
    // eslint-disable-next-line no-console
    console.log("[pattern] stopped after duration window");
  }, totalDurationMs);
}

async function ensureReady() {
  if (!enabled) return;
  if (ready && controller.client?.connected === true) return;
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
  res.json({ ok: true, config: { ...motionConfig, strictMotionTag: strictMotionTagRuntime } });
});

app.post("/config", (req, res) => {
  try {
    // Central place where extension UI values are validated before use.
    motionConfig = sanitizeMotionConfig(req.body ?? {});
    strictMotionTagRuntime = motionConfig.strictMotionTag;
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
    stopPatternRunner();
    lastMotionState = null;
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

app.post("/park-hold", async (_req, res) => {
  try {
    stopPatternRunner();
    lastMotionState = null;
    await ensureReady();
    if (enabled) {
      await controller.parkAtZero();
    }
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
    if (patternTrigger.stop) {
      try {
        stopPatternRunner();
        await controller.stopNow({ cancelPending: true });
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
          `[pattern] start name=${patternTrigger.pattern} speed=${patternTrigger.speed.toFixed(3)} intervalMs=${patternTrigger.intervalMs} durationMs=${patternTrigger.durationMs}`
        );
        await startPatternRunner(patternTrigger);
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
    const runMotion = applySafeModeToMotion(motion, motionConfig);
    rememberLastMotionState(runMotion, motionConfig);
    if (enabled) {
      // eslint-disable-next-line no-console
      console.log(
        "[motion] running",
        runMotion,
        `safeMode=${motionConfig.safeMode} holdUntilNextCommand=${motionConfig.holdUntilNextCommand}`
      );
      if (motionConfig.holdUntilNextCommand) {
        void runMotionAsync(runMotion, motionConfig);
      } else {
        await controller.runMotion(runMotion, motionConfig, {
          stopPreviousOnNewMotion: motionConfig.stopPreviousOnNewMotion,
          holdUntilNextCommand: false
        });
      }
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
        speedMin: motionConfig.speedMin,
        speedMax: motionConfig.speedMax,
        strokeRange: motionConfig.strokeRange,
        globalStrokeMin: motionConfig.globalStrokeMin,
        globalStrokeMax: motionConfig.globalStrokeMax,
        minimumAllowedStroke: motionConfig.minimumAllowedStroke,
        safeMode: motionConfig.safeMode,
        safeMaxSpeed: motionConfig.safeMaxSpeed,
        safeMaxDurationMs: motionConfig.safeMaxDurationMs,
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
      speedMin: motionConfig.speedMin,
      speedMax: motionConfig.speedMax,
      strokeRange: motionConfig.strokeRange,
      globalStrokeMin: motionConfig.globalStrokeMin,
      globalStrokeMax: motionConfig.globalStrokeMax,
      minimumAllowedStroke: motionConfig.minimumAllowedStroke,
      safeMode: motionConfig.safeMode,
      safeMaxSpeed: motionConfig.safeMaxSpeed,
      safeMaxDurationMs: motionConfig.safeMaxDurationMs,
      holdUntilNextCommand: motionConfig.holdUntilNextCommand
    }
  });
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
        // eslint-disable-next-line no-console
        console.log("pattern parsed:", patternTrigger);
        stopPatternRunner();
        try {
          await controller.stopNow({ cancelPending: true });
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
      const runMotion = applySafeModeToMotion(motion, motionConfig);
      rememberLastMotionState(runMotion, motionConfig);
      if (motionConfig.holdUntilNextCommand) {
        void runMotionAsync(runMotion, motionConfig);
      } else {
        await controller.runMotion(runMotion, motionConfig, {
          stopPreviousOnNewMotion: motionConfig.stopPreviousOnNewMotion,
          holdUntilNextCommand: false
        });
      }
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
