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

function computeMappedStrokeWindow(depth, motionConfig) {
  const strokePosition = computeStrokePosition(depth, motionConfig);
  const localMin = clamp01(motionConfig.minimumAllowedStroke ?? 0);
  const logicalMinStroke = applyGlobalStrokeWindow(localMin, motionConfig);
  const logicalMaxStroke = clamp01(Math.max(logicalMinStroke + 0.05, strokePosition));
  const mappedStart = applyPhysicalStrokeWindow(logicalMinStroke, motionConfig);
  const mappedEnd = applyPhysicalStrokeWindow(logicalMaxStroke, motionConfig);
  return {
    minStroke: Math.min(mappedStart, mappedEnd),
    maxStroke: Math.max(mappedStart, mappedEnd)
  };
}

function nowMs() {
  return performance.now();
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "connectionKey" || key === "key" || key.toLowerCase().includes("token")) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactSecrets(nested);
      }
    }
    return output;
  }
  return value;
}

function getNativeProtocol(motionConfig = {}) {
  const value = String(motionConfig.handyNativeProtocol ?? "hrpp").toLowerCase();
  if (value === "hdsp") return "hdsp";
  if (value === "hamp") return "hamp";
  return "hrpp";
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
    this.hampSlideUnsupported = false;
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

  async request(path, key, method = "GET", body = undefined, options = {}) {
    if (!key) {
      throw new Error("Handy connection key is required for native mode.");
    }
    const trace = Boolean(options.trace);
    const keyParam = encodeURIComponent(key);
    // API variants use either connectionKey or key as query parameter.
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.apiBaseUrl}${path}${sep}connectionKey=${keyParam}&key=${keyParam}`;
    const mergedBody =
      body === undefined ? undefined : { connectionKey: key, key, ...body };
    if (trace) {
      // eslint-disable-next-line no-console
      console.log(
        `[native:req] ${method} ${path} body=${JSON.stringify(redactSecrets(mergedBody ?? {}))}`
      );
    }
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
    if (trace) {
      // eslint-disable-next-line no-console
      console.log(`[native:res] ${method} ${path} status=${response.status} body=${JSON.stringify(data)}`);
    }
    if (!response.ok) {
      const errorText = data?.error || data?.message || `Native API request failed (${response.status})`;
      throw new Error(errorText);
    }
    return data;
  }

  async requestWithVariants(path, key, method, payloads, options = {}) {
    let lastError = null;
    for (const payload of payloads) {
      try {
        return await this.request(path, key, method, payload, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`No payload variant succeeded for ${method} ${path}`);
  }

  async connect(motionConfig = {}) {
    this.setApiBaseUrl(motionConfig.handyApiBaseUrl ?? this.apiBaseUrl);
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    if (!key) {
      throw new Error("handyConnectionKey is required when controllerMode=handy-native.");
    }

    const trace = Boolean(motionConfig.handyNativeTrace);
    const connected = await this.request("/connected", key, "GET", undefined, { trace });
    this.lastStatus = connected;
    this.connected = true;
    this.lastConnectAt = Date.now();
    this.lastError = null;
    this.hampSlideUnsupported = false;

    // Put device in configured motion mode. API variants differ by firmware.
    this.modeSet = false;
    const protocol = getNativeProtocol(motionConfig);
    const variants = protocol === "hdsp"
      ? [{ mode: "hdsp" }, { mode: "HDSP" }, { mode: 2 }]
      : protocol === "hamp"
        ? [{ mode: "hamp" }, { mode: "HAMP" }, { mode: 1 }]
        : [{ mode: "hrpp" }, { mode: "HRPP" }, { mode: "hssp" }, { mode: "HSSP" }, { mode: 3 }, { mode: 4 }];
    for (const payload of variants) {
      try {
        await this.request("/mode", key, "PUT", payload, { trace });
        this.modeSet = true;
        break;
      } catch (_error) {
        // try next variant
      }
    }
    if (!this.modeSet && protocol === "hdsp") {
      // eslint-disable-next-line no-console
      console.warn("[native] failed to set explicit HDSP mode; continuing");
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
    const trace = Boolean(motionConfig.handyNativeTrace);
    const endpointPad = Math.max(
      0,
      Math.min(0.2, Number(motionConfig.endpointSafetyPadding ?? 0.03))
    );
    const safePosition = clamp01(
      Math.max(endpointPad, Math.min(1 - endpointPad, position01))
    );
    const nativeMin = clamp01(motionConfig.handyNativeMin ?? 0.25);
    const nativeMax = clamp01(motionConfig.handyNativeMax ?? 0.75);
    const winMin = Math.min(nativeMin, nativeMax);
    const winMax = Math.max(nativeMin, nativeMax);
    const mappedPosition = clamp01(winMin + safePosition * (winMax - winMin));
    const scale = String(motionConfig.handyNativePositionScale ?? "percent").toLowerCase();
    const command = String(motionConfig.handyNativeCommand ?? "xpt").toLowerCase() === "xat"
      ? "xat"
      : "xpt";
    const value = scale === "unit"
      ? Math.round(mappedPosition * 10000) / 10000 // 0..1
      : Math.round(mappedPosition * 10000) / 100; // 0..100
    const t = Math.max(1, Math.round(durationMs));
    // eslint-disable-next-line no-console
    console.log(
      `[native] cmd=${command} value=${value} scale=${scale} t=${t} pad=${Math.round(endpointPad * 100)}% nativeWin=${winMin.toFixed(2)}..${winMax.toFixed(2)}`
    );
    const path = command === "xat" ? "/hdsp/xat" : "/hdsp/xpt";
    const payload = command === "xat"
      ? { xat: value, t, stopOnTarget: false }
      : { xpt: value, t, stopOnTarget: false };
    await this.request(path, key, "PUT", payload, { trace });
  }

  async setModeForProtocol(protocol, motionConfig = {}) {
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);
    const variants = protocol === "hdsp"
      ? [{ mode: "hdsp" }, { mode: "HDSP" }, { mode: 2 }]
      : protocol === "hamp"
        ? [{ mode: "hamp" }, { mode: "HAMP" }, { mode: 1 }]
        : [{ mode: "hrpp" }, { mode: "HRPP" }, { mode: "hssp" }, { mode: "HSSP" }, { mode: 3 }, { mode: 4 }];
    await this.requestWithVariants("/mode", key, "PUT", variants, { trace });
  }

  async sendHdspParkZeroRaw(motionConfig = {}) {
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);
    const t = 450;
    // Bypass all app-side stroke windows/safety for explicit park command.
    // Try both HDSP endpoints and accepted value scales.
    await this.requestWithVariants(
      "/hdsp/xpt",
      key,
      "PUT",
      [
        { xpt: 0, t, stopOnTarget: true },
        { xpt: 0.0, t, stopOnTarget: true }
      ],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hdsp/xat",
      key,
      "PUT",
      [
        { xat: 0, t, stopOnTarget: true },
        { xat: 0.0, t, stopOnTarget: true }
      ],
      { trace }
    ));
  }

  async runMotion(motion, motionConfig = {}, options = {}) {
    await this.connectWithRetry(motionConfig);

    const protocol = getNativeProtocol(motionConfig);
    if (protocol === "hamp") {
      await this.runHampMotion(motion, motionConfig, options);
      return;
    }
    if (protocol === "hrpp") {
      await this.runHrppMotion(motion, motionConfig, options);
      return;
    }

    await this.runHdspMotion(motion, motionConfig, options);
  }

  async runHdspMotion(motion, motionConfig = {}, options = {}) {
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

    const { minStroke, maxStroke } = computeMappedStrokeWindow(motion.depth, motionConfig);
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

  async applyHampSlideWindow(motion, motionConfig = {}) {
    if (this.hampSlideUnsupported) return;
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);
    const { minStroke, maxStroke } = computeMappedStrokeWindow(motion.depth, motionConfig);
    const minPct = Math.round(minStroke * 1000) / 10;
    const maxPct = Math.round(maxStroke * 1000) / 10;
    // eslint-disable-next-line no-console
    console.log(`[native] cmd=hamp slide=${minPct}%..${maxPct}% depth=${motion.depth}`);
    await this.requestWithVariants(
      "/slide",
      key,
      "PUT",
      [
        { min: minPct, max: maxPct },
        { min: minPct, max: maxPct, enabled: true },
        { from: minPct, to: maxPct }
      ],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hamp/slide",
      key,
      "PUT",
      [
        { min: minPct, max: maxPct },
        { from: minPct, to: maxPct }
      ],
      { trace }
    )).catch((error) => {
      this.hampSlideUnsupported = true;
      throw error;
    });
  }

  async runHampMotion(motion, motionConfig = {}, options = {}) {
    const holdUntilNextCommand = options.holdUntilNextCommand ?? false;
    const sequence = ++this.motionSequence;
    await this.ensureDevice(10000, motionConfig);

    const speedMin = motionConfig.speedMin ?? 0;
    const speedMax = motionConfig.speedMax ?? 1;
    const remapped = remapSpeed(motion.speed, speedMin, speedMax);
    const safeCap = motionConfig.safeMode ? 0.75 : 1;
    const styleSpeedFactor = {
      gentle: 0.75,
      normal: 0.95,
      brisk: 1.1,
      hard: 1.25,
      intense: 1.5
    }[motion.style] ?? 1.0;
    const capped = clamp01(Math.min(remapped * styleSpeedFactor, safeCap));
    const speedPct = Math.max(1, Math.min(100, Math.round(capped * 100)));
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);

    try {
      await this.applyHampSlideWindow(motion, motionConfig);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[native] hamp slide window update failed; continuing with speed-only:", error?.message ?? error);
    }

    await this.requestWithVariants(
      "/hamp/start",
      key,
      "PUT",
      [{}, { state: true }, { start: true }],
      { trace }
    );
    // eslint-disable-next-line no-console
    console.log(`[native] cmd=hamp speed=${speedPct}%`);
    // Prefer generic speed setter first (official SDK setSpeed maps to this behavior),
    // then fall back to HAMP velocity endpoint variants.
    await this.requestWithVariants(
      "/speed",
      key,
      "PUT",
      [{ speed: speedPct }, { value: speedPct }],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hamp/velocity",
      key,
      "PUT",
      [{ velocity: speedPct }, { speed: speedPct }, { value: speedPct }],
      { trace }
    ));

    if (holdUntilNextCommand) return;

    const endAt = Date.now() + Math.max(100, Math.round(motion.durationMs));
    while (Date.now() < endAt) {
      if (sequence !== this.motionSequence) return;
      await sleep(Math.min(250, endAt - Date.now()));
    }
    if (sequence !== this.motionSequence) return;
    await this.requestWithVariants(
      "/hamp/stop",
      key,
      "PUT",
      [{}, { state: false }, { stop: true }],
      { trace }
    );
  }

  async runHrppMotion(motion, motionConfig = {}, options = {}) {
    const holdUntilNextCommand = options.holdUntilNextCommand ?? false;
    const sequence = ++this.motionSequence;
    await this.ensureDevice(10000, motionConfig);

    const speedMin = motionConfig.speedMin ?? 0;
    const speedMax = motionConfig.speedMax ?? 1;
    const remapped = remapSpeed(motion.speed, speedMin, speedMax);
    const safeCap = motionConfig.safeMode ? 0.75 : 1;
    const styleSpeedFactor = {
      gentle: 0.75,
      normal: 0.95,
      brisk: 1.1,
      hard: 1.25,
      intense: 1.5
    }[motion.style] ?? 1.0;
    const capped = clamp01(Math.min(remapped * styleSpeedFactor, safeCap));
    const speedPct = Math.max(1, Math.min(100, Math.round(capped * 100)));
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);

    try {
      await this.applyHampSlideWindow(motion, motionConfig);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[native] hrpp slide window update failed; continuing:", error?.message ?? error);
    }

    // Use generic speed endpoint first; fallback to HAMP velocity setter that is
    // still accepted by current firmware while in HRPP/HSSP mode.
    // eslint-disable-next-line no-console
    console.log(`[native] cmd=hrpp speed=${speedPct}%`);
    await this.requestWithVariants(
      "/speed",
      key,
      "PUT",
      [{ speed: speedPct }, { value: speedPct }],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hamp/velocity",
      key,
      "PUT",
      [{ velocity: speedPct }, { speed: speedPct }, { value: speedPct }],
      { trace }
    ));

    // Start repeating pattern playback in HRPP/HSSP mode.
    await this.requestWithVariants(
      "/hssp/loop",
      key,
      "PUT",
      [{ loop: true }, { enabled: true }],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hrpp/loop",
      key,
      "PUT",
      [{ loop: true }, { enabled: true }],
      { trace }
    ));
    await this.requestWithVariants(
      "/hssp/play",
      key,
      "PUT",
      [{}, { startTime: 0 }, { time: 0 }],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hrpp/play",
      key,
      "PUT",
      [{}, { startTime: 0 }, { time: 0 }],
      { trace }
    ));

    if (holdUntilNextCommand) return;

    const endAt = Date.now() + Math.max(100, Math.round(motion.durationMs));
    while (Date.now() < endAt) {
      if (sequence !== this.motionSequence) return;
      await sleep(Math.min(250, endAt - Date.now()));
    }
    if (sequence !== this.motionSequence) return;
    await this.requestWithVariants(
      "/hssp/stop",
      key,
      "PUT",
      [{}, { stop: true }],
      { trace }
    ).catch(async () => this.requestWithVariants(
      "/hrpp/stop",
      key,
      "PUT",
      [{}, { stop: true }],
      { trace }
    ));
  }

  async parkAtZero(motionConfig = {}) {
    this.motionSequence += 1;
    await this.connectWithRetry(motionConfig);
    const protocol = getNativeProtocol(motionConfig);
    if (protocol === "hamp" || protocol === "hrpp") {
      await this.stopNow({ cancelPending: false }, motionConfig);
      try {
        await this.setModeForProtocol("hdsp", motionConfig);
        await this.sendHdspParkZeroRaw(motionConfig);
      } finally {
        try {
          await this.setModeForProtocol(protocol, motionConfig);
        } catch (_error) {
          // Best effort restore.
        }
      }
      return;
    }
    await this.sendHdspParkZeroRaw(motionConfig);
  }

  async stopNow(options = {}, motionConfig = {}) {
    if (options.cancelPending === true) {
      this.motionSequence += 1;
    }
    const key = String(motionConfig.handyConnectionKey ?? "").trim();
    const trace = Boolean(motionConfig.handyNativeTrace);
    if (!key) return;
    const protocol = getNativeProtocol(motionConfig);
    if (protocol === "hrpp") {
      try {
        await this.requestWithVariants(
          "/hssp/stop",
          key,
          "PUT",
          [{}, { stop: true }],
          { trace }
        );
        return;
      } catch (_error) {
        try {
          await this.requestWithVariants(
            "/hrpp/stop",
            key,
            "PUT",
            [{}, { stop: true }],
            { trace }
          );
          return;
        } catch (_error2) {
          // Fallback below.
        }
      }
    }
    if (protocol === "hamp") {
      try {
        await this.requestWithVariants(
          "/hamp/stop",
          key,
          "PUT",
          [{}, { state: false }, { stop: true }],
          { trace }
        );
        return;
      } catch (_error) {
        // Fallback below.
      }
    }
    try {
      await this.request("/hdsp/stop", key, "PUT", {}, { trace });
    } catch (_error) {
      // Best effort fallback.
      try {
        await this.requestWithVariants(
          "/hamp/stop",
          key,
          "PUT",
          [{}, { state: false }, { stop: true }],
          { trace }
        );
      } catch (_error2) {
        // Ignore fallback errors.
      }
    }
  }
}
