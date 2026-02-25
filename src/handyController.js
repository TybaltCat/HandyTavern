import {
  ButtplugClient,
  ButtplugNodeWebsocketClientConnector
} from "buttplug";
import { performance } from "node:perf_hooks";

// Tune how much each parsed depth scales intensity.
const DEPTH_INTENSITY_MULTIPLIER = {
  tip: 0.75,
  middle: 0.9,
  full: 1.0,
  deep: 1.1
};
const RHYTHM_DEBUG =
  String(process.env.RHYTHM_DEBUG ?? "false").toLowerCase() === "true";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeHalfCosine(t) {
  const clamped = clamp01(t);
  // 0..1 with zero velocity at both ends.
  return 0.5 - 0.5 * Math.cos(Math.PI * clamped);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return performance.now();
}

function summarizeIntervals(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  const avg = sum / samples.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const variance =
    samples.reduce((acc, value) => acc + ((value - avg) ** 2), 0) / samples.length;
  const stdev = Math.sqrt(variance);
  return { avg, min, max, p95, stdev };
}

function depthToNormalizedStroke(depth) {
  // Tune depth-to-stroke mapping here (0 = shallow, 1 = deepest position).
  if (depth === "tip") return 0.15;
  if (depth === "middle") return 0.5;
  if (depth === "full") return 0.85;
  return 1.0;
}

function remapSpeed(speed, speedMin, speedMax) {
  const min = clamp01(speedMin);
  const max = clamp01(speedMax);
  if (max <= min) return clamp01(speed);
  return clamp01(min + speed * (max - min));
}

function computeStrokePosition(depth, motionConfig) {
  const minStroke = clamp01(motionConfig.minimumAllowedStroke ?? 0);
  const strokeRange = clamp01(motionConfig.strokeRange ?? 1);
  const local = clamp01(minStroke + depthToNormalizedStroke(depth) * strokeRange);
  return applyGlobalStrokeWindow(local, motionConfig);
}

function getGlobalStrokeWindow(motionConfig) {
  const min = clamp01(motionConfig.globalStrokeMin ?? 0);
  const max = clamp01(motionConfig.globalStrokeMax ?? 1);
  if (max < min) return { min: max, max: min };
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

function cosineStrokePosition(phase, minStroke, maxStroke) {
  const p = ((phase % 1) + 1) % 1;
  const span = maxStroke - minStroke;
  if (p < 0.5) {
    const u = p * 2;
    return minStroke + span * easeHalfCosine(u);
  }
  const u = (p - 0.5) * 2;
  return maxStroke - span * easeHalfCosine(u);
}

async function runLinearIfSupported(device, durationMs, position, payloadState = null) {
  if (typeof device.linear !== "function") return false;

  const safeDurationMs = Math.max(1, Math.round(durationMs));
  const safeDurationSec = Math.max(0.001, safeDurationMs / 1000);
  const safePosition = clamp01(position);

  // This buttplug client expects tuple commands, not object vectors.
  // Keep both ms/sec duration attempts for server-version compatibility.
  const attempts = [
    {
      key: "tuple-ms",
      run: async () => device.linear([[safePosition, safeDurationMs]])
    },
    {
      key: "tuple-sec",
      run: async () => device.linear([[safePosition, safeDurationSec]])
    },
    {
      key: "args-ms",
      run: async () => device.linear(safePosition, safeDurationMs)
    },
    {
      key: "args-sec",
      run: async () => device.linear(safePosition, safeDurationSec)
    }
  ];

  const preferredKey = payloadState?.preferredKey ?? null;
  const ordered = preferredKey
    ? [
        ...attempts.filter((a) => a.key === preferredKey),
        ...attempts.filter((a) => a.key !== preferredKey)
      ]
    : attempts;

  for (const attempt of ordered) {
    try {
      await attempt.run();
      if (payloadState) {
        payloadState.preferredKey = attempt.key;
      }
      return true;
    } catch (_error) {
      // Try next known payload shape.
    }
  }

  return false;
}

async function runLinearSequenceIfSupported(device, sequence, payloadState = null) {
  if (typeof device.linear !== "function") return false;
  if (!Array.isArray(sequence) || sequence.length === 0) return false;

  const seqMs = sequence.map(([position, durationMs]) => [
    clamp01(position),
    Math.max(1, Math.round(durationMs))
  ]);
  const seqSec = seqMs.map(([position, durationMs]) => [
    position,
    Math.max(0.001, durationMs / 1000)
  ]);

  const attempts = [
    { key: "tuple-ms", run: async () => device.linear(seqMs) },
    { key: "tuple-sec", run: async () => device.linear(seqSec) }
  ];

  const preferredKey = payloadState?.preferredKey ?? null;
  const ordered = preferredKey
    ? [
        ...attempts.filter((a) => a.key === preferredKey),
        ...attempts.filter((a) => a.key !== preferredKey)
      ]
    : attempts;

  for (const attempt of ordered) {
    try {
      await attempt.run();
      if (payloadState) {
        payloadState.preferredKey = attempt.key;
      }
      return true;
    } catch (_error) {
      // Try next payload shape.
    }
  }

  return false;
}

async function sendLinearStep(
  device,
  durationMs,
  position,
  rateState = null,
  payloadState = null
) {
  const safePosition = clamp01(position);
  if (rateState) {
    const now = Date.now();
    const elapsed = now - (rateState.lastSentAt ?? 0);
    const waitMs = (rateState.minIntervalMs ?? 0) - elapsed;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    // Optional coalescing for near-duplicate positions.
    if (
      Number.isFinite(rateState.lastPosition) &&
      Math.abs(safePosition - rateState.lastPosition) <= (rateState.minDelta ?? 0) &&
      durationMs <= (rateState.maxCoalesceDurationMs ?? 80)
    ) {
      return;
    }
  }

  const ok = await runLinearIfSupported(device, durationMs, position, payloadState);
  if (!ok) {
    throw new Error("Linear command failed for all supported payload shapes.");
  }

  if (rateState) {
    rateState.lastSentAt = Date.now();
    rateState.lastPosition = safePosition;
  }
}

async function sendLinearCycle(device, halfMs, minStroke, maxStroke, payloadState = null) {
  const sequence = [
    [maxStroke, halfMs],
    [minStroke, halfMs]
  ];
  const ok = await runLinearSequenceIfSupported(device, sequence, payloadState);
  if (!ok) {
    // Fallback to single-step commands if sequence payload is unsupported.
    await sendLinearStep(device, halfMs, maxStroke, null, payloadState);
    await sendLinearStep(device, halfMs, minStroke, null, payloadState);
  }
}

export class HandyController {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl ?? "ws://127.0.0.1:12345";
    this.deviceNameFilter = options.deviceNameFilter?.toLowerCase() ?? "handy";
    this.clientName = options.clientName ?? "TavernPlug";
    this.client = null;
    this.device = null;
    this.connectingPromise = null;
    this.lastError = null;
    this.lastConnectAt = 0;
    this.lastDeviceCapabilities = {
      linear: false,
      scalar: false,
      vibrate: false
    };
    this.linearPayloadState = { preferredKey: null };
    // Used to cancel older in-flight motions when preemption is enabled.
    this.motionSequence = 0;
  }

  getStatus() {
    return {
      connected: Boolean(this.client?.connected),
      selectedDevice: this.device?.name ?? null,
      capabilities: this.lastDeviceCapabilities,
      lastError: this.lastError,
      lastConnectAt: this.lastConnectAt
    };
  }

  async connect() {
    if (this.connectingPromise) {
      await this.connectingPromise;
      return;
    }

    this.connectingPromise = this._connectInternal();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  async _connectInternal() {
    if (this.client && this.client.connected === true) return;

    // Recover from stale/disconnected client instances.
    if (this.client && this.client.connected !== true) {
      this.client = null;
      this.device = null;
    }

    this.client = new ButtplugClient(this.clientName);
    const connector = new ButtplugNodeWebsocketClientConnector(this.serverUrl);
    try {
      await this.client.connect(connector);
      this.lastConnectAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

    this.client.addListener("deviceadded", (device) => {
      // eslint-disable-next-line no-console
      console.log(`[device] discovered: ${device.name}`);
      if (
        !this.device &&
        device.name.toLowerCase().includes(this.deviceNameFilter)
      ) {
        // eslint-disable-next-line no-console
        console.log(`[device] selected: ${device.name}`);
        this.device = device;
        this.refreshDeviceCapabilities(device);
      }
    });
    this.client.addListener("disconnect", () => {
      this.device = null;
      this.lastDeviceCapabilities = {
        linear: false,
        scalar: false,
        vibrate: false
      };
    });

    this.selectFromExistingDevices();
    await this.client.startScanning();
  }

  async connectWithRetry(maxAttempts = 4) {
    let attempt = 0;
    let lastError = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error;
        const backoffMs = Math.min(3000, 250 * (2 ** (attempt - 1)));
        await sleep(backoffMs);
      }
    }
    throw lastError ?? new Error("Connection attempts failed.");
  }

  refreshDeviceCapabilities(device = this.device) {
    this.lastDeviceCapabilities = {
      linear: Boolean(device && typeof device.linear === "function"),
      scalar: Boolean(device && typeof device.scalar === "function"),
      vibrate: Boolean(device && typeof device.vibrate === "function")
    };
  }

  validateDeviceCapabilities(device = this.device) {
    this.refreshDeviceCapabilities(device);
    if (
      !this.lastDeviceCapabilities.linear &&
      !this.lastDeviceCapabilities.scalar &&
      !this.lastDeviceCapabilities.vibrate
    ) {
      throw new Error(
        "Selected device has no supported actuators (linear/scalar/vibrate)."
      );
    }
  }

  selectFromExistingDevices() {
    if (!this.client || this.device) return;

    // Depending on buttplug client version, devices may be exposed as an array or map-like object.
    const rawDevices = this.client.devices;
    const devices = Array.isArray(rawDevices)
      ? rawDevices
      : rawDevices && typeof rawDevices.values === "function"
        ? Array.from(rawDevices.values())
        : [];

    for (const device of devices) {
      // eslint-disable-next-line no-console
      console.log(`[device] existing: ${device.name}`);
      if (device.name.toLowerCase().includes(this.deviceNameFilter)) {
        // eslint-disable-next-line no-console
        console.log(`[device] selected existing: ${device.name}`);
        this.device = device;
        this.refreshDeviceCapabilities(device);
        return;
      }
    }
  }

  async ensureDevice(timeoutMs = 10000) {
    this.selectFromExistingDevices();
    if (this.device) return this.device;

    const end = Date.now() + timeoutMs;
    while (!this.device && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!this.device) {
      throw new Error(
        `No matching device found. Looking for name containing "${this.deviceNameFilter}".`
      );
    }
    this.validateDeviceCapabilities(this.device);

    return this.device;
  }

  async runMotion(motion, motionConfig = {}, options = {}) {
    if (!this.client || this.client.connected !== true) {
      await this.connectWithRetry();
    }

    const holdUntilNextCommand = options.holdUntilNextCommand ?? false;
    // Hold mode always requires preemption so old loops can terminate.
    const stopPreviousOnNewMotion =
      holdUntilNextCommand || (options.stopPreviousOnNewMotion ?? true);
    const sequence = stopPreviousOnNewMotion
      ? ++this.motionSequence
      : this.motionSequence;
    const device = await this.ensureDevice();
    const depthMultiplier = DEPTH_INTENSITY_MULTIPLIER[motion.depth] ?? 1;
    // User-tunable speed window. Incoming speed is remapped into this range.
    const speedMin = motionConfig.speedMin ?? 0;
    const speedMax = motionConfig.speedMax ?? 1;
    const remapped = remapSpeed(motion.speed, speedMin, speedMax);
    const safeCap = motionConfig.safeMode ? 0.75 : 1;
    const remappedNormalizedSpeed = clamp01(
      Math.min(remapped, safeCap) / Math.max(0.001, safeCap)
    );
    const scalar = clamp01(remapped * depthMultiplier);
    // User-tunable stroke limits are applied inside computeStrokePosition().
    const strokePosition = computeStrokePosition(motion.depth, motionConfig);
    const localMin = clamp01(motionConfig.minimumAllowedStroke ?? 0);
    const logicalMinStroke = applyGlobalStrokeWindow(localMin, motionConfig);
    const logicalMaxStroke = clamp01(Math.max(logicalMinStroke + 0.05, strokePosition));
    const mappedStart = applyPhysicalStrokeWindow(logicalMinStroke, motionConfig);
    const mappedEnd = applyPhysicalStrokeWindow(logicalMaxStroke, motionConfig);
    const minStroke = Math.min(mappedStart, mappedEnd);
    const maxStroke = Math.max(mappedStart, mappedEnd);
    // Stronger speed separation across the configured window.
    // Slower styles become noticeably slower and faster styles much faster.
    // Deterministic tempo:
    // 1) Base tempo comes from remapped speed window (user/global setting).
    // 2) Style multiplier then separates gentle/brisk/normal/hard/intense clearly.
    const baseHalfCycleMs = Math.max(
      12,
      Math.round(560 * Math.pow(0.03, remappedNormalizedSpeed))
    );
    const styleHalfCycleFactor = {
      gentle: 1.45,
      normal: 1.0,
      brisk: 0.82,
      hard: 0.66,
      intense: 0.42
    }[motion.style] ?? 1.0;
    const halfCycleMs = Math.max(8, Math.round(baseHalfCycleMs * styleHalfCycleFactor));

    if (stopPreviousOnNewMotion) {
      await this.stopNow();
      if (sequence !== this.motionSequence) return;
    }

    if (typeof device.linear === "function") {
      const cycleMs = Math.max(24, halfCycleMs * 2);
      const cadenceMs = Math.max(
        35,
        Math.min(120, Math.round(130 - remappedNormalizedSpeed * 80))
      );
      const bufferMsTarget = Math.max(
        2000,
        Math.min(5000, Math.round(2200 + (1 - remappedNormalizedSpeed) * 1800))
      );
      const topUpMs = Math.max(500, Math.round(bufferMsTarget / 2));
      let phase = 0;
      const end = Date.now() + motion.durationMs;
      while (holdUntilNextCommand || Date.now() < end) {
        if (stopPreviousOnNewMotion && sequence !== this.motionSequence) return;

        const remainingMs = holdUntilNextCommand ? bufferMsTarget : end - Date.now();
        if (remainingMs <= 0) break;
        const horizonMs = Math.max(0, Math.min(bufferMsTarget, remainingMs));
        const pointCount = Math.max(1, Math.floor(horizonMs / cadenceMs));
        const sequencePoints = [];
        for (let i = 0; i < pointCount; i += 1) {
          phase += cadenceMs / cycleMs;
          const pos = cosineStrokePosition(phase, minStroke, maxStroke);
          sequencePoints.push([pos, cadenceMs]);
        }

        const ok = await runLinearSequenceIfSupported(
          device,
          sequencePoints,
          this.linearPayloadState
        );

        if (!ok) {
          // Fallback path for servers that don't accept multi-point linear sequences.
          for (const [pos, dur] of sequencePoints) {
            if (stopPreviousOnNewMotion && sequence !== this.motionSequence) return;
            await sendLinearStep(device, dur, pos, null, this.linearPayloadState);
          }
        }

        if (RHYTHM_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(
            `[rhythm] mode=buffered style=${motion.style} depth=${motion.depth} cadenceMs=${cadenceMs} points=${sequencePoints.length} horizonMs=${pointCount * cadenceMs} cycleMs=${cycleMs}`
          );
        }

        const sleepFor = holdUntilNextCommand
          ? topUpMs
          : Math.min(topUpMs, Math.max(0, end - Date.now()));
        if (sleepFor > 0) {
          await sleep(sleepFor);
        }
      }
      await this.stopNow();
      return;
    }

    if (typeof device.scalar === "function") {
      await device.scalar(scalar);
    } else if (typeof device.vibrate === "function") {
      await device.vibrate(scalar);
    } else {
      throw new Error("Device does not support scalar/vibrate commands.");
    }

    if (holdUntilNextCommand) {
      while (!stopPreviousOnNewMotion || sequence === this.motionSequence) {
        await sleep(100);
      }
      return;
    }

    if (stopPreviousOnNewMotion) {
      const end = Date.now() + motion.durationMs;
      while (Date.now() < end) {
        if (sequence !== this.motionSequence) return;
        await sleep(Math.min(100, end - Date.now()));
      }
    } else {
      await sleep(motion.durationMs);
    }

    await this.stopNow();
  }

  async parkAtZero(motionConfig = {}) {
    if (!this.client || this.client.connected !== true) {
      await this.connectWithRetry();
    }

    const device = await this.ensureDevice();
    // Cancel any active loops so park position is stable until next command.
    this.motionSequence += 1;
    await this.stopNow();

    if (typeof device.linear === "function") {
      // Park should be absolute device position 0, not remapped through
      // runtime stroke windows, so users always get a deterministic endpoint.
      await sendLinearStep(device, 450, 0, null, this.linearPayloadState);
      return;
    }

    if (typeof device.scalar === "function") {
      await device.scalar(0);
      return;
    }
    if (typeof device.vibrate === "function") {
      await device.vibrate(0);
    }
  }

  async stopNow(options = {}) {
    if (options.cancelPending === true) {
      this.motionSequence += 1;
    }

    if (!this.device) return;
    const device = this.device;

    if (typeof device.stop === "function") {
      await device.stop();
    } else if (typeof device.scalar === "function") {
      await device.scalar(0);
    } else if (typeof device.vibrate === "function") {
      await device.vibrate(0);
    }
  }
}
