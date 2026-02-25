import { performance } from "node:perf_hooks";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function remapSpeed(speed, speedMin, speedMax) {
  const min = clamp01(speedMin);
  const max = clamp01(speedMax);
  if (max <= min) return clamp01(speed);
  return clamp01(min + speed * (max - min));
}

function depthToNormalizedStroke(depth) {
  if (depth === "tip") return 0.15;
  if (depth === "middle") return 0.5;
  if (depth === "full") return 0.85;
  return 1.0;
}

function getGlobalStrokeWindow(motionConfig) {
  const pad = Math.max(0, Math.min(0.2, Number(motionConfig.endpointSafetyPadding ?? 0.03)));
  const rawMin = clamp01(motionConfig.globalStrokeMin ?? 0);
  const rawMax = clamp01(motionConfig.globalStrokeMax ?? 1);
  const min = Math.max(Math.min(rawMin, rawMax), pad);
  const max = Math.min(Math.max(rawMin, rawMax), 1 - pad);
  if (max < min) return { min, max: min };
  return { min, max };
}

function applyGlobalStrokeWindow(value, motionConfig) {
  const { min, max } = getGlobalStrokeWindow(motionConfig);
  return clamp01(min + clamp01(value) * (max - min));
}

function getPhysicalStrokeWindow(motionConfig) {
  const min = clamp01(motionConfig.physicalMin ?? 0);
  const max = clamp01(motionConfig.physicalMax ?? 1);
  if (max < min) return { min: max, max: min };
  return { min, max };
}

function applyPhysicalStrokeWindow(value, motionConfig) {
  const { min, max } = getPhysicalStrokeWindow(motionConfig);
  const local = clamp01(value);
  const normalized = motionConfig.invertStroke ? 1 - local : local;
  return clamp01(min + normalized * (max - min));
}

function computeStrokePosition(depth, motionConfig) {
  const minStroke = clamp01(motionConfig.minimumAllowedStroke ?? 0);
  const strokeRange = clamp01(motionConfig.strokeRange ?? 1);
  const local = clamp01(minStroke + depthToNormalizedStroke(depth) * strokeRange);
  return applyGlobalStrokeWindow(local, motionConfig);
}

function nowMs() {
  return performance.now();
}

export class HandyNativeController {
  constructor(options = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://www.handyfeeling.com/api/handy/v2").replace(/\/$/, "");
    this.clientName = options.clientName ?? "TavernPlug";
    this.connected = false;
    this.lastError = null;
    this.lastConnectAt = 0;
    this.lastStatus = null;
    this.motionSequence = 0;
    this.modeSet = false;
  }

  setApiBaseUrl(url) {
    if (!url) return;
    this.apiBaseUrl = String(url).replace(/\/$/, "");
  }

  getStatus() {
    return {
      connected: this.connected,
      selectedDevice: "Handy Native API",
      capabilities: {
        linear: true,
        scalar: false,
        vibrate: false
      },
      lastError: this.lastError,
      lastConnectAt: this.lastConnectAt,
      apiBaseUrl: this.apiBaseUrl,
      modeSet: this.modeSet,
      nativeStatus: this.lastStatus
    };
  }

  async request(path, key, method = "GET", body = undefined) {
    if (!key) {
      throw new Error("Handy connection key is required for native mode.");
    }
    const keyParam = encodeURIComponent(key);
    // API variants use either connectionKey or key as query parameter.
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.apiBaseUrl}${path}${sep}connectionKey=${keyParam}&key=${keyParam}`;
    const mergedBody =
      body === undefined ? undefined : { connectionKey: key, key, ...body };
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Client-Name": this.clientName,
        "X-Connection-Key": key
      },
      body: mergedBody === undefined ? undefined : JSON.stringify(mergedBody)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorText = data?.error || data?.message || `Native API request failed (${response.status})`;
      throw new Error(errorText);
    }
    return data;
  }

  async connect(motionConfig = {}) {
    this.setApiBaseUrl(motionConfig.handyApiBaseUrl ?? this.apiBaseUrl);
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    if (!key) {
      throw new Error("handyConnectionKey is required when controllerMode=handy-native.");
    }

    const connected = await this.request("/connected", key, "GET");
    this.lastStatus = connected;
    this.connected = true;
    this.lastConnectAt = Date.now();
    this.lastError = null;

    // Put device in HDSP mode for timed target position moves.
    // API variants differ, so try string then numeric mode value.
    try {
      await this.request("/mode", key, "PUT", { mode: "hdsp" });
      this.modeSet = true;
    } catch (_error) {
      await this.request("/mode", key, "PUT", { mode: 2 });
      this.modeSet = true;
    }
  }

  async connectWithRetry(motionConfig = {}, maxAttempts = 4) {
    let attempt = 0;
    let lastError = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        await this.connect(motionConfig);
        return;
      } catch (error) {
        lastError = error;
        this.lastError = error instanceof Error ? error.message : String(error);
        const backoffMs = Math.min(3000, 250 * (2 ** (attempt - 1)));
        await sleep(backoffMs);
      }
    }
    throw lastError ?? new Error("Native controller connection attempts failed.");
  }

  async ensureDevice(_timeoutMs = 10000, motionConfig = {}) {
    if (!this.connected) {
      await this.connectWithRetry(motionConfig);
    }
    return { name: "Handy Native API" };
  }

  async sendHdspXpt(position01, durationMs, motionConfig = {}) {
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const endpointPad = Math.max(
      0,
      Math.min(0.2, Number(motionConfig.endpointSafetyPadding ?? 0.03))
    );
    const safePosition = clamp01(
      Math.max(endpointPad, Math.min(1 - endpointPad, position01))
    );
    const scale = String(motionConfig.handyNativePositionScale ?? "percent").toLowerCase();
    const xpt = scale === "unit"
      ? Math.round(safePosition * 10000) / 10000 // 0..1
      : Math.round(safePosition * 10000) / 100; // 0..100
    const t = Math.max(1, Math.round(durationMs));
    // eslint-disable-next-line no-console
    console.log(
      `[native] xpt=${xpt} scale=${scale} t=${t} pad=${Math.round(endpointPad * 100)}%`
    );
    // Common payload for HDSP percent+time endpoint.
    await this.request("/hdsp/xpt", key, "PUT", { xpt, t, stopOnTarget: false });
  }

  async runMotion(motion, motionConfig = {}, options = {}) {
    await this.connectWithRetry(motionConfig);

    const holdUntilNextCommand = options.holdUntilNextCommand ?? false;
    const sequence = ++this.motionSequence;
    await this.ensureDevice(10000, motionConfig);

    const speedMin = motionConfig.speedMin ?? 0;
    const speedMax = motionConfig.speedMax ?? 1;
    const remapped = remapSpeed(motion.speed, speedMin, speedMax);
    const safeCap = motionConfig.safeMode ? 0.75 : 1;
    const remappedNormalizedSpeed = clamp01(
      Math.min(remapped, safeCap) / Math.max(0.001, safeCap)
    );

    const strokePosition = computeStrokePosition(motion.depth, motionConfig);
    const localMin = clamp01(motionConfig.minimumAllowedStroke ?? 0);
    const logicalMinStroke = applyGlobalStrokeWindow(localMin, motionConfig);
    const logicalMaxStroke = clamp01(Math.max(logicalMinStroke + 0.05, strokePosition));
    const mappedStart = applyPhysicalStrokeWindow(logicalMinStroke, motionConfig);
    const mappedEnd = applyPhysicalStrokeWindow(logicalMaxStroke, motionConfig);
    const minStroke = Math.min(mappedStart, mappedEnd);
    const maxStroke = Math.max(mappedStart, mappedEnd);
    const baseHalfCycleMs = Math.max(
      20,
      Math.round(700 * Math.pow(0.05, remappedNormalizedSpeed))
    );
    const styleHalfCycleFactor = {
      gentle: 1.45,
      normal: 1.0,
      brisk: 0.82,
      hard: 0.66,
      intense: 0.42
    }[motion.style] ?? 1.0;
    const halfCycleMs = Math.max(16, Math.round(baseHalfCycleMs * styleHalfCycleFactor));

    let toMax = true;
    const end = Date.now() + motion.durationMs;
    let lastDispatchAt = 0;
    const cycleMs = Math.max(2, halfCycleMs * 2);
    while (holdUntilNextCommand || Date.now() < end) {
      if (sequence !== this.motionSequence) return;
      const remaining = holdUntilNextCommand ? cycleMs : end - Date.now();
      if (!holdUntilNextCommand && remaining < cycleMs) {
        break;
      }

      if (lastDispatchAt > 0) {
        const dueAt = lastDispatchAt + cycleMs;
        const waitMs = dueAt - nowMs();
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      if (sequence !== this.motionSequence) return;

      if (toMax) {
        await this.sendHdspXpt(maxStroke, halfCycleMs, motionConfig);
        await this.sendHdspXpt(minStroke, halfCycleMs, motionConfig);
      } else {
        await this.sendHdspXpt(minStroke, halfCycleMs, motionConfig);
        await this.sendHdspXpt(maxStroke, halfCycleMs, motionConfig);
      }
      lastDispatchAt = nowMs();
      toMax = !toMax;
    }
  }

  async parkAtZero(motionConfig = {}) {
    this.motionSequence += 1;
    await this.connectWithRetry(motionConfig);
    await this.sendHdspXpt(0, 450, motionConfig);
  }

  async stopNow(options = {}, motionConfig = {}) {
    if (options.cancelPending === true) {
      this.motionSequence += 1;
    }
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    if (!key) return;
    try {
      await this.request("/hdsp/stop", key, "PUT", {});
    } catch (_error) {
      // Best effort fallback.
      try {
        await this.request("/hamp/stop", key, "PUT", {});
      } catch (_error2) {
        // Ignore fallback errors.
      }
    }
  }
}
