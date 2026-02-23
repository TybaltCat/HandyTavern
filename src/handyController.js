import {
  ButtplugClient,
  ButtplugNodeWebsocketClientConnector
} from "buttplug";

// Tune how much each parsed depth scales intensity.
const DEPTH_INTENSITY_MULTIPLIER = {
  tip: 0.75,
  middle: 0.9,
  full: 1.0,
  deep: 1.1
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return clamp01(minStroke + depthToNormalizedStroke(depth) * strokeRange);
}

async function runLinearIfSupported(device, durationMs, position) {
  if (typeof device.linear !== "function") return false;

  const safeDurationMs = Math.max(1, Math.round(durationMs));
  const safeDurationSec = Math.max(0.001, safeDurationMs / 1000);
  const safePosition = clamp01(position);

  // This buttplug client expects tuple commands, not object vectors.
  // Keep both ms/sec duration attempts for server-version compatibility.
  const attempts = [
    async () => device.linear([[safePosition, safeDurationMs]]),
    async () => device.linear([[safePosition, safeDurationSec]]),
    async () => device.linear(safePosition, safeDurationMs),
    async () => device.linear(safePosition, safeDurationSec)
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      return true;
    } catch (_error) {
      // Try next known payload shape.
    }
  }

  return false;
}

async function sendLinearStep(device, durationMs, position) {
  const ok = await runLinearIfSupported(device, durationMs, position);
  if (!ok) {
    throw new Error("Linear command failed for all supported payload shapes.");
  }
}

export class HandyController {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl ?? "ws://127.0.0.1:12345";
    this.deviceNameFilter = options.deviceNameFilter?.toLowerCase() ?? "handy";
    this.clientName = options.clientName ?? "TavernPlug";
    this.client = null;
    this.device = null;
    // Used to cancel older in-flight motions when preemption is enabled.
    this.motionSequence = 0;
  }

  async connect() {
    if (this.client && this.client.connected === true) return;

    // Recover from stale/disconnected client instances.
    if (this.client && this.client.connected !== true) {
      this.client = null;
      this.device = null;
    }

    this.client = new ButtplugClient(this.clientName);
    const connector = new ButtplugNodeWebsocketClientConnector(this.serverUrl);
    await this.client.connect(connector);

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
      }
    });

    this.selectFromExistingDevices();
    await this.client.startScanning();
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

    return this.device;
  }

  async runMotion(motion, motionConfig = {}, options = {}) {
    if (!this.client || this.client.connected !== true) {
      await this.connect();
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
    const scalar = clamp01(remapped * depthMultiplier);
    // User-tunable stroke limits are applied inside computeStrokePosition().
    const strokePosition = computeStrokePosition(motion.depth, motionConfig);
    const minStroke = clamp01(motionConfig.minimumAllowedStroke ?? 0);
    const maxStroke = Math.max(minStroke + 0.05, strokePosition);
    const halfCycleMs = Math.max(120, Math.round(800 - remapped * 650));

    if (stopPreviousOnNewMotion) {
      await this.stopNow();
      if (sequence !== this.motionSequence) return;
    }

    if (typeof device.linear === "function") {
      let toMax = true;
      const end = Date.now() + motion.durationMs;
      while (holdUntilNextCommand || Date.now() < end) {
        if (stopPreviousOnNewMotion && sequence !== this.motionSequence) return;
        const remaining = holdUntilNextCommand ? halfCycleMs : end - Date.now();
        const stepMs = Math.max(40, Math.min(halfCycleMs, remaining));
        const target = toMax ? maxStroke : minStroke;
        await sendLinearStep(device, stepMs, target);
        toMax = !toMax;
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
