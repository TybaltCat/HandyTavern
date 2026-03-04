const EXTENSION_NAME = "tavernplug-handy";
// Add new extension-level settings defaults here.
const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8787",
  controllerMode: "handy-native",
  handyNativeProtocol: "hamp",
  handyNativeBackend: "thehandy",
  handyApiBaseUrl: "https://www.handyfeeling.com/api/handy/v2",
  handyNativePositionScale: "percent",
  handyNativeCommand: "xpt",
  handyNativeTrace: false,
  handyNativeMinPct: 25,
  handyNativeMaxPct: 75,
  pollIntervalMs: 2000,
  autoSend: true,
  paused: false,
  strictTagOnly: false,
  showDebugInfo: true,
  advancedOpen: false,
  speedProfilesOpen: false,
  uiMode: "basic",
  setupGuideOpen: false,
  holdUntilNextCommand: true,
  stopPreviousOnNewMotion: true,
  panelCollapsed: true,
  safeMode: true,
  safeMaxSpeed: 75,
  patternIntervalMs: 15000,
  cumDepth: "deep",
  cumStrokePct: 90,
  cumSpeedPct: 75,
  cumDurationMs: 6000,
  testSpeedGentlePct: 20,
  testSpeedBriskPct: 55,
  testSpeedNormalPct: 40,
  testSpeedHardPct: 65,
  testSpeedIntensePct: 90,
  handyConnectionKey: "",
  globalStrokeMinPct: 0,
  globalStrokeMaxPct: 75,
  physicalMinPct: 0,
  physicalMaxPct: 100,
  invertStroke: false,
  strokeRange: 100,
  speedMin: 0,
  speedMax: 75,
  minimumAllowedStroke: 0,
  endpointSafetyPaddingPct: 5
};
const LOCKED_TECHNICAL_DEFAULTS = {
  invertStroke: false,
  handyNativePositionScale: "percent",
  handyNativeCommand: "xpt",
  handyNativeTrace: false,
  handyNativeMinPct: 25,
  handyNativeMaxPct: 75
};
const LOCKED_CONTROLLER_MODE = "handy-native";

function applyLockedTechnicalSettings(target) {
  target.invertStroke = LOCKED_TECHNICAL_DEFAULTS.invertStroke;
  target.handyNativePositionScale = LOCKED_TECHNICAL_DEFAULTS.handyNativePositionScale;
  target.handyNativeCommand = LOCKED_TECHNICAL_DEFAULTS.handyNativeCommand;
  target.handyNativeTrace = LOCKED_TECHNICAL_DEFAULTS.handyNativeTrace;
  target.handyNativeMinPct = LOCKED_TECHNICAL_DEFAULTS.handyNativeMinPct;
  target.handyNativeMaxPct = LOCKED_TECHNICAL_DEFAULTS.handyNativeMaxPct;
}

function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getExtensionSettingsStore() {
  const context = getContextSafe();
  if (!context) return null;
  if (!context.extensionSettings) context.extensionSettings = {};
  return context.extensionSettings;
}

function saveSettings() {
  const context = getContextSafe();
  if (typeof context?.saveSettingsDebounced === "function") {
    context.saveSettingsDebounced();
  }
}

const extensionSettingsStore = getExtensionSettingsStore() ?? {};
const settings = extensionSettingsStore[EXTENSION_NAME] ?? {};
Object.assign(settings, DEFAULTS, settings);
settings.controllerMode = LOCKED_CONTROLLER_MODE;
applyLockedTechnicalSettings(settings);
if (!["hamp", "hdsp", "hrpp"].includes(String(settings.handyNativeProtocol ?? "").toLowerCase())) {
  settings.handyNativeProtocol = "hamp";
}
if (!["thehandy", "builtin"].includes(String(settings.handyNativeBackend ?? "").toLowerCase())) {
  settings.handyNativeBackend = "thehandy";
}
// Migrate older default profile where brisk was slower than normal.
if (Number(settings.testSpeedBriskPct) === 40 && Number(settings.testSpeedNormalPct) === 55) {
  settings.testSpeedBriskPct = 55;
  settings.testSpeedNormalPct = 40;
}
if (Number(settings.testSpeedHardPct) >= Number(settings.testSpeedIntensePct)) {
  settings.testSpeedIntensePct = Math.min(100, Number(settings.testSpeedHardPct) + 15);
}
if (settings.cumStrokePct === undefined || settings.cumStrokePct === null || settings.cumStrokePct === "") {
  const depth = String(settings.cumDepth ?? "").toLowerCase();
  const migrated = {
    tip: 20,
    middle: 45,
    full: 70,
    deep: 90
  };
  settings.cumStrokePct = migrated[depth] ?? 90;
}
normalizePercentSetting("strokeRange");
normalizePercentSetting("speedMin");
normalizePercentSetting("speedMax");
normalizePercentSetting("minimumAllowedStroke");
normalizePercentSetting("safeMaxSpeed");
normalizePercentSetting("testSpeedGentlePct");
normalizePercentSetting("testSpeedBriskPct");
normalizePercentSetting("testSpeedNormalPct");
normalizePercentSetting("testSpeedHardPct");
normalizePercentSetting("testSpeedIntensePct");
normalizePercentSetting("cumStrokePct");
normalizePercentSetting("cumSpeedPct");
normalizePercentSetting("globalStrokeMinPct");
normalizePercentSetting("globalStrokeMaxPct");
normalizePercentSetting("physicalMinPct");
normalizePercentSetting("physicalMaxPct");
normalizePercentSetting("endpointSafetyPaddingPct");
normalizePercentSetting("handyNativeMinPct");
normalizePercentSetting("handyNativeMaxPct");
if (Number(settings.patternIntervalMs) < 3000) {
  settings.patternIntervalMs = 15000;
}
extensionSettingsStore[EXTENSION_NAME] = settings;

let lastSentMessageId = -1;
let lastSentMessageSignature = "";
let pollHandle = null;
let healthHandle = null;
let healthFailureCount = 0;
let healthPollingPaused = false;
let bridgeHealthDetected = false;
let statusEl = null;
let modeStateEl = null;
let healthEl = null;
let setupStateEl = null;
let setupHintEl = null;
let panelRetryHandle = null;
let testModeActive = false;
let testModeStyle = "normal";
let testModeDepth = "middle";
let preTestHoldSetting = null;
let patternIntervalHandle = null;
let activePatternName = null;
let patternStep = 0;
let patternRunToken = 0;
let quickStopRetryHandle = null;
let lastObservedMessageId = -1;
let lastObservedMessageText = "";
let lastObservedMessageChangedAt = 0;
let lastNonCumMotionPayload = null;
let cumOverrideActive = false;
let cumRestorePayload = null;

const MESSAGE_STABILIZE_MS = 1200;

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function normalizePercentSetting(name) {
  const raw = Number(settings[name]);
  if (!Number.isFinite(raw)) return;
  // Migrate older 0..1 settings to 0..100 display values.
  if (raw >= 0 && raw <= 1) {
    settings[name] = raw * 100;
  }
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setHealth(message) {
  if (healthEl) healthEl.textContent = message;
}

function setSetupState(state, hint = "", tone = "neutral") {
  if (setupStateEl) {
    setupStateEl.textContent = state;
    setupStateEl.dataset.state = tone;
  }
  if (setupHintEl) setupHintEl.textContent = hint;
}

function updateBridgeWarning(panel = null) {
  const activePanel = panel ?? document.querySelector(`#${EXTENSION_NAME}-panel`);
  if (!activePanel) return;
  const warningEl = activePanel.querySelector(".tavernplug-bridge-warning");
  if (!warningEl) return;
  warningEl.style.display = bridgeHealthDetected ? "none" : "block";
}

function hasConfiguredConnectionKey() {
  return String(settings.handyConnectionKey ?? "").trim().length > 0;
}

function cloneMotionPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const text = String(payload.text ?? "").trim();
  if (!text) return null;
  const next = { text };
  const rawCumStrokePct = Number(payload.cumStrokePct);
  if (Number.isFinite(rawCumStrokePct)) {
    next.cumStrokePct = clampPercent(rawCumStrokePct);
  }
  const rawSlideMinPct = Number(payload.slideMinPct);
  const rawSlideMaxPct = Number(payload.slideMaxPct);
  if (Number.isFinite(rawSlideMinPct) && Number.isFinite(rawSlideMaxPct)) {
    next.slideMinPct = clampPercent(Math.min(rawSlideMinPct, rawSlideMaxPct));
    next.slideMaxPct = clampPercent(Math.max(rawSlideMinPct, rawSlideMaxPct));
  }
  return next;
}

function markNonCumMotionPayload(payload) {
  const normalized = cloneMotionPayload(payload);
  if (!normalized) return;
  lastNonCumMotionPayload = normalized;
  cumOverrideActive = false;
  cumRestorePayload = null;
}

function setSyncButtonConnected(connected) {
  const button = document.querySelector(`#${EXTENSION_NAME}-sync-test`);
  if (!button) return;
  button.classList.toggle("tavernplug-sync-ok", Boolean(connected));
}

function updateModeStateLine() {
  if (!modeStateEl) return;
  modeStateEl.textContent = [
    `Mode: ${settings.controllerMode === "handy-native" ? "Native" : "Buttplug"}`,
    `Paused: ${settings.paused ? "ON" : "OFF"}`,
    `Strict: ${settings.strictTagOnly ? "ON" : "OFF"}`,
    `Hold: ${settings.holdUntilNextCommand ? "ON" : "OFF"}`,
    `Safe: ${settings.safeMode ? "ON" : "OFF"}`,
    `Test: ${testModeActive ? "ON" : "OFF"}`,
    `Pattern: ${activePatternName ?? "OFF"}`
  ].join(" | ");
}

function updateSafeButtons() {
  const button = document.querySelector(`#${EXTENSION_NAME}-safe-toggle`);
  if (!button) return;
  if (settings.safeMode) {
    button.textContent = "Safe ON";
    button.classList.add("tavernplug-safe-on-btn");
    button.classList.remove("tavernplug-safe-off-btn");
  } else {
    button.textContent = "Safe OFF";
    button.classList.add("tavernplug-safe-off-btn");
    button.classList.remove("tavernplug-safe-on-btn");
  }
}

function updateHoldButton() {
  const button = document.querySelector(`#${EXTENSION_NAME}-hold-toggle`);
  if (!button) return;
  if (settings.holdUntilNextCommand) {
    button.textContent = "Hold ON";
    button.classList.add("tavernplug-hold-on-btn");
    button.classList.remove("tavernplug-hold-off-btn");
  } else {
    button.textContent = "Hold OFF";
    button.classList.add("tavernplug-hold-off-btn");
    button.classList.remove("tavernplug-hold-on-btn");
  }
}

function updateStrictButton() {
  const button = document.querySelector(`#${EXTENSION_NAME}-strict-toggle`);
  if (!button) return;
  if (settings.strictTagOnly) {
    button.textContent = "Strict ON";
    button.classList.add("tavernplug-strict-on-btn");
    button.classList.remove("tavernplug-strict-off-btn");
  } else {
    button.textContent = "Strict OFF";
    button.classList.add("tavernplug-strict-off-btn");
    button.classList.remove("tavernplug-strict-on-btn");
  }
}

function applyDebugVisibility() {
  const visible = Boolean(settings.showDebugInfo);
  const display = visible ? "" : "none";
  if (modeStateEl) modeStateEl.style.display = display;
  if (healthEl) healthEl.style.display = display;
  if (statusEl) statusEl.style.display = display;
}

function updateGlobalStrokeSlider(panel) {
  if (!panel) return;
  let min = clampPercent(settings.globalStrokeMinPct);
  let max = clampPercent(settings.globalStrokeMaxPct);
  if (max < min) {
    const temp = min;
    min = max;
    max = temp;
    settings.globalStrokeMinPct = min;
    settings.globalStrokeMaxPct = max;
  }

  const minInput = panel.querySelector(`input[name="globalStrokeMinPct"]`);
  const maxInput = panel.querySelector(`input[name="globalStrokeMaxPct"]`);
  const valueEl = panel.querySelector(".tavernplug-global-range-value");
  const track = panel.querySelector(".tavernplug-global-range");

  if (minInput) minInput.value = String(min);
  if (maxInput) maxInput.value = String(max);
  if (valueEl) valueEl.textContent = `${min}% to ${max}%`;
  if (track) {
    track.style.setProperty("--range-min", `${min}%`);
    track.style.setProperty("--range-max", `${max}%`);
  }
}

function updateGlobalSpeedSlider(panel) {
  if (!panel) return;
  let min = clampPercent(settings.speedMin);
  let max = clampPercent(settings.speedMax);
  if (max < min) {
    const temp = min;
    min = max;
    max = temp;
    settings.speedMin = min;
    settings.speedMax = max;
  }

  const minInput = panel.querySelector(`input[name="speedMin"]`);
  const maxInput = panel.querySelector(`input[name="speedMax"]`);
  const valueEl = panel.querySelector(".tavernplug-speed-range-value");
  const track = panel.querySelector(".tavernplug-speed-range");

  if (minInput) minInput.value = String(min);
  if (maxInput) maxInput.value = String(max);
  if (valueEl) valueEl.textContent = `${min}% to ${max}%`;
  if (track) {
    track.style.setProperty("--range-min", `${min}%`);
    track.style.setProperty("--range-max", `${max}%`);
  }
}

function cumDepthFromStrokePct(raw) {
  const pct = clampPercent(raw);
  if (pct < 25) return "tip";
  if (pct < 50) return "middle";
  if (pct < 75) return "full";
  return "deep";
}

function updateCumStrokeValue(panel) {
  if (!panel) return;
  const input = panel.querySelector(`input[name="cumStrokePct"]`);
  const valueEl = panel.querySelector(".tavernplug-cum-stroke-value");
  const pct = clampPercent(settings.cumStrokePct);
  if (input) input.value = String(pct);
  if (valueEl) valueEl.textContent = `${pct}% (${cumDepthFromStrokePct(pct)})`;
}

function setAdvancedOpen(panel, open) {
  settings.advancedOpen = Boolean(open);
  const body = panel.querySelector(".tavernplug-advanced-body");
  const button = panel.querySelector(".tavernplug-advanced-toggle");
  if (body) body.style.display = settings.advancedOpen ? "block" : "none";
  if (button) {
    button.textContent = settings.advancedOpen
      ? "Advanced Settings (-)"
      : "Advanced Settings (+)";
  }
  saveSettings();
}

function setSpeedProfilesOpen(panel, open) {
  settings.speedProfilesOpen = Boolean(open);
  const body = panel.querySelector(".tavernplug-speed-profiles-body");
  const button = panel.querySelector(".tavernplug-speed-profiles-toggle");
  if (body) body.style.display = settings.speedProfilesOpen ? "block" : "none";
  if (button) {
    button.textContent = settings.speedProfilesOpen
      ? "Speed Profiles (-)"
      : "Speed Profiles (+)";
  }
  saveSettings();
}

function updateUiModeControls(panel) {
  if (!panel) return;
  const advanced = settings.uiMode === "advanced";
  panel.querySelectorAll("[data-ui-mode='advanced']").forEach((element) => {
    if (!advanced) {
      element.style.display = "none";
      return;
    }
    if (element.classList.contains("tavernplug-advanced-body")) {
      element.style.display = settings.advancedOpen ? "block" : "none";
      return;
    }
    if (element.classList.contains("tavernplug-speed-profiles-body")) {
      element.style.display = settings.speedProfilesOpen ? "block" : "none";
      return;
    }
    element.style.display = "";
  });
  const basicButton = panel.querySelector(`#${EXTENSION_NAME}-ui-basic`);
  const advancedButton = panel.querySelector(`#${EXTENSION_NAME}-ui-advanced`);
  if (basicButton) basicButton.classList.toggle("tavernplug-mode-selected", !advanced);
  if (advancedButton) advancedButton.classList.toggle("tavernplug-mode-selected", advanced);
}

function setUiMode(mode) {
  settings.uiMode = mode === "advanced" ? "advanced" : "basic";
  const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
  updateUiModeControls(panel);
  saveSettings();
  setStatus(`View set to ${settings.uiMode}`);
}

function setSetupGuideOpen(panel, open) {
  settings.setupGuideOpen = Boolean(open);
  const body = panel.querySelector(".tavernplug-setup-guide-body");
  const button = panel.querySelector(`#${EXTENSION_NAME}-setup-guide`);
  if (body) body.style.display = settings.setupGuideOpen ? "block" : "none";
  if (button) {
    button.textContent = settings.setupGuideOpen ? "Hide Setup Help" : "Show Setup Help";
  }
  saveSettings();
}

function messageHasMotionTag(text) {
  return /\[motion:\s*[^\]]+\]/i.test(text);
}

function shouldSkipMessageText(text) {
  const value = String(text ?? "");
  return /\bclothes guide:/i.test(value) || /\[ooc:/i.test(value);
}

function findSettingsContainer() {
  return (
    document.querySelector("#extensions_settings") ||
    document.querySelector("#extensions_settings2") ||
    document.querySelector(".extensions_settings")
  );
}

function findQuickStopContainer() {
  return (
    document.querySelector("#send_form") ||
    document.querySelector("#chat_form") ||
    document.querySelector("#send_textarea")?.closest("form") ||
    document.querySelector("#send_textarea")?.parentElement ||
    document.querySelector(".send_form") ||
    document.querySelector(".chat_input") ||
    null
  );
}

async function postJson(path, payload) {
  const base = String(settings.bridgeUrl || DEFAULTS.bridgeUrl).replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function fetchHealth() {
  const base = String(settings.bridgeUrl || DEFAULTS.bridgeUrl).replace(/\/$/, "");
  const response = await fetch(`${base}/health`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || `Health failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function getAssistantMessageFromContext() {
  const context = getContextSafe();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    const text = String(message.mes ?? "").trim();
    if (!text) continue;
    return { id: i, text };
  }
  return null;
}

async function syncConfig() {
  // Keep this payload aligned with POST /config in src/index.js.
  const payload = {
    controllerMode: LOCKED_CONTROLLER_MODE,
    handyNativeProtocol: String(settings.handyNativeProtocol ?? "hamp"),
    handyNativeBackend: String(settings.handyNativeBackend ?? "thehandy"),
    handyApiBaseUrl: String(settings.handyApiBaseUrl ?? ""),
    handyNativePositionScale: LOCKED_TECHNICAL_DEFAULTS.handyNativePositionScale,
    handyNativeCommand: LOCKED_TECHNICAL_DEFAULTS.handyNativeCommand,
    handyNativeTrace: LOCKED_TECHNICAL_DEFAULTS.handyNativeTrace,
    handyNativeMin: LOCKED_TECHNICAL_DEFAULTS.handyNativeMinPct / 100,
    handyNativeMax: LOCKED_TECHNICAL_DEFAULTS.handyNativeMaxPct / 100,
    handyConnectionKey: String(settings.handyConnectionKey ?? ""),
    globalStrokeMin: clampPercent(settings.globalStrokeMinPct) / 100,
    globalStrokeMax: clampPercent(settings.globalStrokeMaxPct) / 100,
    physicalMin: clampPercent(settings.physicalMinPct) / 100,
    physicalMax: clampPercent(settings.physicalMaxPct) / 100,
    invertStroke: LOCKED_TECHNICAL_DEFAULTS.invertStroke,
    strokeRange: clampPercent(settings.strokeRange) / 100,
    speedMin: clampPercent(settings.speedMin) / 100,
    speedMax: clampPercent(settings.speedMax) / 100,
    minimumAllowedStroke: clampPercent(settings.minimumAllowedStroke) / 100,
    endpointSafetyPadding: Math.max(0, Math.min(20, clampPercent(settings.endpointSafetyPaddingPct))) / 100,
    safeMode: Boolean(settings.safeMode),
    safeMaxSpeed: clampPercent(settings.safeMaxSpeed) / 100,
    strictMotionTag: Boolean(settings.strictTagOnly),
    holdUntilNextCommand: Boolean(settings.holdUntilNextCommand),
    stopPreviousOnNewMotion: Boolean(settings.stopPreviousOnNewMotion)
  };

  try {
    await postJson("/config", payload);
    healthFailureCount = 0;
    healthPollingPaused = false;
    bridgeHealthDetected = true;
    startHealthPolling();
    updateBridgeWarning();
    setSetupState(
      "Bridge reachable",
      "Bridge is responding. Click Connect Device to pair with your Handy.",
      "warn"
    );
    setStatus("Config synced");
    return true;
  } catch (error) {
    setSetupState(
      "Bridge offline",
      "Start the local TavernPlug bridge, then try Connect Device again.",
      "error"
    );
    const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
    if (panel && !settings.setupGuideOpen) {
      setSetupGuideOpen(panel, true);
    }
    setStatus(`Config error: ${error.message}. Is bridge running on ${settings.bridgeUrl}?`);
    return false;
  }
}

async function handleSyncAndTestConnection() {
  const synced = await syncConfig();
  if (!synced) return;
  try {
    const result = await postJson("/connect", {});
    const mode = result?.mode || settings.controllerMode;
    const connected = result?.controller?.connected ? "connected" : "disconnected";
    const device = result?.controller?.selectedDevice || "none";
    setHealth(`Bridge: ${connected} | Mode: ${mode} | Device: ${device} | Motion: idle`);
    setSyncButtonConnected(result?.controller?.connected);
    if (result?.controller?.connected && hasConfiguredConnectionKey()) {
      setSetupState("Ready", `Connected to ${device}. Motion control is ready.`, "ok");
    } else {
      setSetupState(
        "Bridge reachable",
        hasConfiguredConnectionKey()
          ? "Bridge answered, but no device connected yet. Verify your Handy key and retry."
          : "Bridge answered, but your Handy Connection Key is still empty.",
        "warn"
      );
    }
    setStatus(`Connected (${mode})`);
  } catch (error) {
    setSyncButtonConnected(false);
    setSetupState(
      "Bridge reachable",
      "Bridge answered, but device connection failed. Recheck your Handy key and retry.",
      "error"
    );
    setStatus(`Connect test failed: ${error.message}`);
  }
}

function handleSetupGuide() {
  const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
  if (!panel) return;
  setSetupGuideOpen(panel, !settings.setupGuideOpen);
}

async function handleCheckBridge() {
  try {
    const health = await fetchHealth();
    bridgeHealthDetected = true;
    updateBridgeWarning();
    const connected = health?.controller?.connected ? "connected" : "disconnected";
    const device = health?.controller?.selectedDevice || "none";
    const mode = health?.controllerMode || settings.controllerMode || "handy-native";
    const active = health?.motionLikelyActive ? "active" : "idle";
    setHealth(`Bridge: ${connected} | Mode: ${mode} | Device: ${device} | Motion: ${active}`);
    setSyncButtonConnected(Boolean(health?.controller?.connected));
    if (health?.controller?.connected && hasConfiguredConnectionKey()) {
      setSetupState("Ready", `Bridge and device look good. Connected to ${device}.`, "ok");
    } else {
      setSetupState(
        "Bridge reachable",
        hasConfiguredConnectionKey()
          ? "Bridge is online. If your Handy is not connecting, paste your key and click Connect Device."
          : "Bridge is online, but your Handy Connection Key is still empty.",
        "warn"
      );
    }
    setStatus("Bridge check OK");
  } catch (error) {
    setHealth("Bridge: offline");
    setSyncButtonConnected(false);
    setSetupState(
      "Bridge offline",
      "The local bridge is not responding. Start it with npm start, then retry.",
      "error"
    );
    const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
    if (panel && !settings.setupGuideOpen) {
      setSetupGuideOpen(panel, true);
    }
    setStatus(`Bridge check failed: ${error.message}`);
  }
}

async function sendMotionIfNeeded(message) {
  if (!settings.autoSend || !message) return;
  if (settings.paused) return;
  const text = String(message.text ?? "");
  const now = Date.now();

  // Wait until streamed assistant text appears stable before sending.
  if (message.id !== lastObservedMessageId || text !== lastObservedMessageText) {
    lastObservedMessageId = message.id;
    lastObservedMessageText = text;
    lastObservedMessageChangedAt = now;
    return;
  }
  if (now - lastObservedMessageChangedAt < MESSAGE_STABILIZE_MS) return;

  const signature = `${message.id}:${text}`;
  if (signature === lastSentMessageSignature) return;

  if (shouldSkipMessageText(message.text)) {
    lastSentMessageId = message.id;
    lastSentMessageSignature = signature;
    setStatus(`Skipped message ${message.id} (filtered)`);
    return;
  }
  if (settings.strictTagOnly && !messageHasMotionTag(message.text)) return;

  try {
    const payload = { text: message.text };
    await postJson("/motion", payload);
    lastSentMessageId = message.id;
    lastSentMessageSignature = signature;
    markNonCumMotionPayload(payload);
    setStatus(`Sent message ${message.id}`);
  } catch (error) {
    setStatus(`Motion error: ${error.message}`);
  }
}

function onInputChange(event) {
  const { name, type } = event.target;
  if (!name || !Object.prototype.hasOwnProperty.call(settings, name)) return;
  if (name === "controllerMode") {
    settings.controllerMode = LOCKED_CONTROLLER_MODE;
    event.target.value = LOCKED_CONTROLLER_MODE;
    saveSettings();
    setStatus("Controller backend locked to Handy Native");
    return;
  }

  if (
    name === "invertStroke"
    || name === "handyNativePositionScale"
    || name === "handyNativeCommand"
    || name === "handyNativeTrace"
    || name === "handyNativeMinPct"
    || name === "handyNativeMaxPct"
  ) {
    applyLockedTechnicalSettings(settings);
    if (type === "checkbox") {
      event.target.checked = Boolean(settings[name]);
    } else {
      event.target.value = String(settings[name]);
    }
    saveSettings();
    setStatus("Technical setting locked to safe default");
    return;
  }

  if (name === "safeMode" && type === "checkbox" && event.target.checked === false) {
    const confirmed = window.confirm(
      "Turning off safe mode may break your dick and/or ruin your asshole. You've been warned. On hitting okay SAFE MODE WILL BE OFF and may god have mercy on your soul."
    );
    if (!confirmed) {
      event.target.checked = true;
      return;
    }
  }

  settings[name] = type === "checkbox" ? event.target.checked : event.target.value;
  if (name === "handyApiBaseUrl") {
    settings[name] = String(settings[name] || "").trim();
  }
  if (name === "handyNativeBackend") {
    settings[name] = String(settings[name]).toLowerCase() === "builtin" ? "builtin" : "thehandy";
  }
  if (name === "handyNativePositionScale") {
    settings[name] = String(settings[name]).toLowerCase() === "unit" ? "unit" : "percent";
  }
  if (name === "handyNativeCommand") {
    settings[name] = String(settings[name]).toLowerCase() === "xat" ? "xat" : "xpt";
  }
  if (
    type === "number" &&
    [
      "strokeRange",
      "speedMin",
      "speedMax",
      "minimumAllowedStroke",
      "safeMaxSpeed",
      "testSpeedGentlePct",
      "testSpeedBriskPct",
      "testSpeedNormalPct",
      "testSpeedHardPct",
      "testSpeedIntensePct",
      "cumSpeedPct",
      "globalStrokeMinPct",
      "globalStrokeMaxPct",
      "physicalMinPct",
      "physicalMaxPct",
      "endpointSafetyPaddingPct",
      "handyNativeMinPct",
      "handyNativeMaxPct"
    ].includes(name)
  ) {
    settings[name] = clampPercent(settings[name]);
  }
  if (name === "safeMaxSpeed") {
    settings[name] = Math.min(75, clampPercent(settings[name]));
  }
  if (name === "endpointSafetyPaddingPct") {
    settings[name] = Math.max(0, Math.min(20, clampPercent(settings[name])));
  }
  if (name === "handyNativeMinPct") {
    settings[name] = clampPercent(settings[name]);
    if (Number(settings.handyNativeMinPct) > Number(settings.handyNativeMaxPct)) {
      settings.handyNativeMaxPct = settings.handyNativeMinPct;
    }
  }
  if (name === "handyNativeMaxPct") {
    settings[name] = clampPercent(settings[name]);
    if (Number(settings.handyNativeMaxPct) < Number(settings.handyNativeMinPct)) {
      settings.handyNativeMinPct = settings.handyNativeMaxPct;
    }
  }
  if (name === "globalStrokeMinPct" && Number(settings.globalStrokeMinPct) > Number(settings.globalStrokeMaxPct)) {
    settings.globalStrokeMaxPct = settings.globalStrokeMinPct;
  }
  if (name === "globalStrokeMaxPct" && Number(settings.globalStrokeMaxPct) < Number(settings.globalStrokeMinPct)) {
    settings.globalStrokeMinPct = settings.globalStrokeMaxPct;
  }
  if (name === "physicalMinPct" && Number(settings.physicalMinPct) > Number(settings.physicalMaxPct)) {
    settings.physicalMaxPct = settings.physicalMinPct;
  }
  if (name === "physicalMaxPct" && Number(settings.physicalMaxPct) < Number(settings.physicalMinPct)) {
    settings.physicalMinPct = settings.physicalMaxPct;
  }
  if (name === "speedMin" && Number(settings.speedMin) > Number(settings.speedMax)) {
    settings.speedMax = settings.speedMin;
  }
  if (name === "speedMax" && Number(settings.speedMax) < Number(settings.speedMin)) {
    settings.speedMin = settings.speedMax;
  }
  if (settings.safeMode && (name === "speedMin" || name === "speedMax")) {
    if (Number(settings.speedMax) > 75) {
      settings.speedMax = 75;
      if (name === "speedMax") {
        event.target.value = "75";
      }
      window.alert("Safe Mode is ON: Global Speed Window cannot exceed 75%.");
    }
    if (Number(settings.speedMin) > 75) {
      settings.speedMin = 75;
      if (name === "speedMin") {
        event.target.value = "75";
      }
      window.alert("Safe Mode is ON: Global Speed Window cannot exceed 75%.");
    }
  }
  if (type === "number" && name === "patternIntervalMs") {
    settings[name] = Math.max(3000, Math.min(120000, Number(settings[name]) || 15000));
  }
  if (name === "cumStrokePct") {
    settings[name] = clampPercent(settings[name]);
  }
  if (type === "number" && name === "cumDurationMs") {
    const seconds = Number(settings[name]);
    const clampedSeconds = Math.max(0.25, Math.min(120, Number.isFinite(seconds) ? seconds : 6));
    settings[name] = Math.round(clampedSeconds * 1000);
    event.target.value = String(clampedSeconds);
  }
  if (type === "number" && name === "pollIntervalMs") {
    settings[name] = Math.max(500, Math.min(60000, Number(settings[name]) || 3000));
  }
  const isLiveMotionControl = [
    "strokeRange",
    "minimumAllowedStroke",
    "speedMin",
    "speedMax",
    "testSpeedGentlePct",
    "testSpeedBriskPct",
    "testSpeedNormalPct",
    "testSpeedHardPct",
    "testSpeedIntensePct",
    "globalStrokeMinPct",
    "globalStrokeMaxPct",
    "physicalMinPct",
    "physicalMaxPct",
    "endpointSafetyPaddingPct",
    "handyNativeMinPct",
    "handyNativeMaxPct"
  ].includes(name);
  const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
  if (name === "globalStrokeMinPct" || name === "globalStrokeMaxPct") {
    updateGlobalStrokeSlider(panel);
  }
  if (name === "speedMin" || name === "speedMax") {
    updateGlobalSpeedSlider(panel);
  }
  if (name === "cumStrokePct") {
    updateCumStrokeValue(panel);
  }
  saveSettings();
  // Any UI setting change is pushed to the local bridge immediately.
  void syncConfig();
  if (activePatternName && name === "patternIntervalMs") {
    setTimeout(() => {
      void startPatternMode(activePatternName);
    }, 150);
  }
  if (name === "pollIntervalMs") {
    restartPolling();
    setStatus(`Poll interval set to ${settings.pollIntervalMs}ms`);
  }
  if (name === "showDebugInfo") {
    applyDebugVisibility();
  }
  if (testModeActive && isLiveMotionControl) {
    // Re-send current mode so live adjustments apply immediately.
    setTimeout(() => {
      void sendModeTest(testModeStyle, testModeDepth);
    }, 150);
  }

  // Re-check latest assistant message immediately after config changes,
  // so users do not have to wait for the next polling tick.
  setTimeout(() => {
    const latest = getAssistantMessageFromContext();
    void sendMotionIfNeeded(latest);
  }, 120);
}

async function handleEmergencyStop() {
  try {
    stopPatternMode(false);
    await postJson("/emergency-stop", {});
    cumOverrideActive = false;
    cumRestorePayload = null;
    setStatus("Emergency stop sent");
  } catch (error) {
    setStatus(`Stop error: ${error.message}`);
  }
}

function updateQuickPauseButton() {
  const button = document.querySelector(`#${EXTENSION_NAME}-quick-pause`);
  if (!button) return;
  if (settings.paused) {
    button.textContent = "Resume";
    button.classList.add("tavernplug-quick-pause-on");
  } else {
    button.textContent = "Pause";
    button.classList.remove("tavernplug-quick-pause-on");
  }
}

async function togglePause() {
  settings.paused = !settings.paused;
  saveSettings();
  updateModeStateLine();
  updateQuickPauseButton();
  if (settings.paused) {
    try {
      stopPatternMode(false);
      await postJson("/emergency-stop", {});
      cumOverrideActive = false;
      cumRestorePayload = null;
      setStatus("Paused: motion stopped");
    } catch (error) {
      setStatus(`Pause error: ${error.message}`);
    }
    return;
  }
  try {
    const resumeSpeed = currentStyleSpeed("normal");
    const resumeTag = `[motion: style=normal speed=${resumeSpeed} depth=middle duration=3s]`;
    const payload = { text: resumeTag };
    await postJson("/motion", payload);
    markNonCumMotionPayload(payload);
    setStatus(`Resumed: normal/middle @ ${resumeSpeed}`);
  } catch (error) {
    setStatus(`Resume error: ${error.message}`);
  }
}

async function handleParkHold() {
  try {
    stopPatternMode(false);
    await postJson("/park-hold", {});
    cumOverrideActive = false;
    cumRestorePayload = null;
    setStatus("Parked at 0 until next command");
  } catch (error) {
    setStatus(`Park error: ${error.message}`);
  }
}

function cumStyleFromSpeedPct(rawSpeedPct) {
  const speed = clampPercent(rawSpeedPct);
  if (speed < 30) return "gentle";
  if (speed < 50) return "normal";
  if (speed < 65) return "brisk";
  if (speed < 80) return "hard";
  return "intense";
}

async function handleCumAction() {
  if (settings.paused) {
    setStatus("Paused: cum action blocked");
    return;
  }
  if (cumOverrideActive) {
    const restore = cloneMotionPayload(cumRestorePayload)
      || cloneMotionPayload(lastNonCumMotionPayload)
      || { text: `[motion: style=normal speed=${currentStyleSpeed("normal")} depth=middle duration=3s]` };
    try {
      stopPatternMode(false);
      await postJson("/motion", restore);
      markNonCumMotionPayload(restore);
      setStatus("Cum toggle: restored previous motion");
    } catch (error) {
      setStatus(`Cum restore error: ${error.message}`);
    }
    return;
  }

  const style = cumStyleFromSpeedPct(settings.cumSpeedPct);
  const cumStrokePct = clampPercent(settings.cumStrokePct);
  const depth = cumDepthFromStrokePct(cumStrokePct);
  const speed = clampPercent(settings.cumSpeedPct);
  const durationMs = Math.max(250, Math.min(120000, Number(settings.cumDurationMs) || 6000));
  const durationSec = (durationMs / 1000).toFixed(2).replace(/\.00$/, "");
  const tag = `[motion: style=${style} speed=${speed} depth=${depth} duration=${durationSec}s]`;
  try {
    stopPatternMode(false);
    cumRestorePayload = cloneMotionPayload(lastNonCumMotionPayload);
    await postJson("/motion", { text: tag, cumStrokePct });
    cumOverrideActive = true;
    setStatus(`Cum action sent: ${style}/${depth} (${cumStrokePct}%) @ ${speed}%`);
  } catch (error) {
    cumOverrideActive = false;
    cumRestorePayload = null;
    setStatus(`Cum action error: ${error.message}`);
  }
}

async function startTestMode() {
  if (settings.paused) {
    setStatus("Paused: test mode blocked");
    return;
  }
  const testButton = document.querySelector(`#${EXTENSION_NAME}-test`);
  preTestHoldSetting = Boolean(settings.holdUntilNextCommand);
  settings.holdUntilNextCommand = true;
  saveSettings();
  await syncConfig();
  testModeActive = true;
  updateModeStateLine();
  if (testButton) testButton.textContent = "Test Mode Stop";
  await sendModeTest(testModeStyle, testModeDepth);
  setStatus("Test mode started");
}

function stopPatternMode(updateStatus = true) {
  patternRunToken += 1;
  if (patternIntervalHandle) {
    clearInterval(patternIntervalHandle);
    patternIntervalHandle = null;
  }
  activePatternName = null;
  patternStep = 0;
  updateModeStateLine();
  if (updateStatus) setStatus("Pattern stopped");
}

function patternCycleSteps(name) {
  if (name === "wave") return 8;
  if (name === "pulse") return 6;
  if (name === "ramp") return 5;
  if (name === "tease_hold") return 4;
  if (name === "edging_ramp") return 5;
  if (name === "pulse_bursts") return 4;
  if (name === "depth_ladder") return 4;
  if (name === "stutter_break") return 6;
  if (name === "climax_window") return 4;
  return 6;
}

function patternCycleTargetMs(name, baseCycleMs) {
  if (name === "wave") return Math.round(baseCycleMs * 1.5);
  if (name === "ramp") return Math.round(baseCycleMs * 1.35);
  return baseCycleMs;
}

function patternStepSpan(name, step) {
  if (name === "stutter_break") {
    const phase = step % 3;
    if (phase === 0) return 3;
    if (phase === 1) return 2;
    return 1;
  }
  return 1;
}

function patternStepDelayMs(baseIntervalMs) {
  const jitterScale = 0.12;
  const delta = (Math.random() * 2 - 1) * jitterScale;
  return Math.max(250, Math.round(baseIntervalMs * (1 + delta)));
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
    if (step % 6 === 5) return { style: "gentle", depth: "deep", speedPct: 20 };
    return { style: "normal", depth: "middle" };
  }

  if (name === "ramp") {
    const cycle = ["gentle", "normal", "brisk", "hard", "intense"];
    return { style: cycle[step % cycle.length], depth: "middle" };
  }

  if (name === "tease_hold") {
    const cycle = [
      ["gentle", "tip"],
      ["gentle", "tip"],
      ["normal", "tip"],
      ["gentle", "tip"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth, slideMinPct: 80, slideMaxPct: 95 };
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
      ["gentle", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  if (name === "depth_ladder") {
    const cycle = [
      { style: "normal", depth: "tip", slideMinPct: 0, slideMaxPct: 35 },
      { style: "normal", depth: "middle", slideMinPct: 35, slideMaxPct: 50 },
      { style: "hard", depth: "full", slideMinPct: 50, slideMaxPct: 60 },
      { style: "normal", depth: "full", slideMinPct: 60, slideMaxPct: 75 }
    ];
    return cycle[step % cycle.length];
  }

  if (name === "stutter_break") {
    if (step % 3 === 1) return { style: "intense", depth: "tip", slideMinPct: 0, slideMaxPct: 20 };
    if (step % 3 === 2) return { style: "gentle", depth: "middle" };
    return { style: "hard", depth: "full" };
  }

  if (name === "climax_window") {
    const cycle = [
      ["hard", "full"],
      ["intense", "deep"],
      ["hard", "full"],
      ["brisk", "middle"]
    ];
    const [style, depth] = cycle[step % cycle.length];
    return { style, depth };
  }

  const styles = ["normal", "brisk", "hard"];
  const depths = ["middle", "full", "deep"];
  return {
    style: styles[Math.floor(Math.random() * styles.length)],
    depth: depths[Math.floor(Math.random() * depths.length)]
  };
}

async function startPatternMode(name) {
  if (settings.paused) {
    setStatus("Paused: pattern blocked");
    return;
  }
  if (!testModeActive) {
    await startTestMode();
  }
  stopPatternMode(false);
  const runToken = ++patternRunToken;
  activePatternName = name;
  patternStep = 0;
  updateModeStateLine();

  const tick = async (durationSecOverride = null) => {
    const frame = nextPatternFrame(name, patternStep);
    await sendModeTest(frame.style, frame.depth, frame, durationSecOverride);
  };

  const baseCycleMs = Math.max(
    3000,
    Math.min(120000, Number(settings.patternIntervalMs) || 15000)
  );
  const cycleMs = patternCycleTargetMs(name, baseCycleMs);
  const intervalMs = Math.max(
    300,
    Math.round(cycleMs / patternCycleSteps(name))
  );
  const durationForDelayMs = (delayMs) => {
    const overlapMs = 600;
    return Math.max(3, Number(((delayMs + overlapMs) / 1000).toFixed(2)));
  };
  await tick(durationForDelayMs(intervalMs * patternStepSpan(name, patternStep)));
  const scheduleNext = () => {
    if (runToken !== patternRunToken) return;
    const delayMs = patternStepDelayMs(intervalMs * patternStepSpan(name, patternStep));
    patternIntervalHandle = setTimeout(async () => {
      if (runToken !== patternRunToken) return;
      patternStep += 1;
      await tick(durationForDelayMs(delayMs));
      scheduleNext();
    }, delayMs);
  };
  scheduleNext();
  setStatus(`Pattern running: ${name} over ~${cycleMs}ms (~${intervalMs}ms per beat)`);
}

async function handleTestMotion() {
  const testButton = document.querySelector(`#${EXTENSION_NAME}-test`);
  if (!testModeActive) {
    await startTestMode();
    return;
  }

  try {
    stopPatternMode(false);
    await postJson("/emergency-stop", {});
    if (preTestHoldSetting !== null) {
      settings.holdUntilNextCommand = preTestHoldSetting;
      preTestHoldSetting = null;
      saveSettings();
      await syncConfig();
    }
    testModeActive = false;
    updateModeStateLine();
    if (testButton) testButton.textContent = "Test Mode Start";
    setStatus("Test mode stopped");
  } catch (error) {
    setStatus(`Test error: ${error.message}`);
  }
}

function speedSettingKeyForStyle(style) {
  if (style === "gentle") return "testSpeedGentlePct";
  if (style === "brisk") return "testSpeedBriskPct";
  if (style === "hard") return "testSpeedHardPct";
  if (style === "intense") return "testSpeedIntensePct";
  return "testSpeedNormalPct";
}

function styleSpeedInputId(style) {
  return `${EXTENSION_NAME}-speed-${style}`;
}

function currentStyleSpeed(style) {
  const min = clampPercent(settings.speedMin);
  const max = clampPercent(settings.speedMax);
  if (max < min) return min;

  const stylePct = clampPercent(settings[speedSettingKeyForStyle(style)]);
  const clamped = Math.max(min, Math.min(max, stylePct));
  return Math.round(clamped);
}

function adjustStyleSpeed(style, delta) {
  const key = speedSettingKeyForStyle(style);
  const current = Number(settings[key]) || 0;
  settings[key] = clampPercent(current + delta);
  const input = document.querySelector(`#${styleSpeedInputId(style)}`);
  if (input) input.value = settings[key];
  saveSettings();
  void syncConfig();
  if (testModeActive) {
    setTimeout(() => {
      void sendModeTest(testModeStyle, testModeDepth);
    }, 120);
  }
}

async function sendModeTest(style, depth, options = {}, durationSecOverride = null) {
  if (settings.paused) {
    setStatus("Paused: mode test blocked");
    return;
  }
  testModeStyle = style;
  testModeDepth = depth;
  const overrideSpeed = Number(options.speedPct);
  const speed = Number.isFinite(overrideSpeed)
    ? clampPercent(overrideSpeed)
    : currentStyleSpeed(style);
  const durationSec = Number.isFinite(Number(durationSecOverride))
    ? Math.max(1, Number(durationSecOverride))
    : 3;
  const formattedDuration = String(durationSec).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  const testTag = `[motion: style=${style} speed=${speed} depth=${depth} duration=${formattedDuration}s]`;
  try {
    const payload = { text: testTag };
    const rawSlideMinPct = Number(options.slideMinPct);
    const rawSlideMaxPct = Number(options.slideMaxPct);
    if (Number.isFinite(rawSlideMinPct) && Number.isFinite(rawSlideMaxPct)) {
      payload.slideMinPct = clampPercent(Math.min(rawSlideMinPct, rawSlideMaxPct));
      payload.slideMaxPct = clampPercent(Math.max(rawSlideMinPct, rawSlideMaxPct));
    }
    await postJson("/motion", payload);
    markNonCumMotionPayload(payload);
    setStatus(`Mode test sent: ${style}/${depth} @ ${speed}`);
  } catch (error) {
    setStatus(`Mode test error: ${error.message}`);
  }
}

async function toggleSafeMode(enabled) {
  if (!enabled && settings.safeMode) {
    const confirmed = window.confirm(
      "Turning off safe mode may break your dick and/or ruin your asshole. You've been warned. On hitting okay SAFE MODE WILL BE OFF and may god have mercy on your soul."
    );
    if (!confirmed) {
      return;
    }
  }
  settings.safeMode = Boolean(enabled);
  saveSettings();
  await syncConfig();
  updateModeStateLine();
  updateSafeButtons();
  setStatus(`Safe Mode ${settings.safeMode ? "ON" : "OFF"}`);
}

async function toggleHoldMode(enabled) {
  settings.holdUntilNextCommand = Boolean(enabled);
  saveSettings();
  await syncConfig();
  updateModeStateLine();
  updateHoldButton();
  setStatus(`Hold Until Next Command ${settings.holdUntilNextCommand ? "ON" : "OFF"}`);
}

function toggleStrictMode(enabled) {
  settings.strictTagOnly = Boolean(enabled);
  saveSettings();
  updateModeStateLine();
  updateStrictButton();
  setStatus(`Strict Tags ${settings.strictTagOnly ? "ON" : "OFF"}`);
}

function setPanelCollapsed(panel, collapsed) {
  settings.panelCollapsed = Boolean(collapsed);
  panel.classList.toggle("tavernplug-collapsed", settings.panelCollapsed);
  panel.classList.toggle("open", !settings.panelCollapsed);
  const body = panel.querySelector(".tavernplug-body");
  if (body) body.style.display = settings.panelCollapsed ? "none" : "block";
  const toggle = panel.querySelector(".tavernplug-toggle");
  if (toggle) {
    toggle.classList.toggle("fa-circle-chevron-right", settings.panelCollapsed);
    toggle.classList.toggle("fa-circle-chevron-down", !settings.panelCollapsed);
    toggle.classList.toggle("down", !settings.panelCollapsed);
    toggle.setAttribute("aria-expanded", settings.panelCollapsed ? "false" : "true");
  }
  saveSettings();
}

function renderSettingsPanel() {
  const container = findSettingsContainer();
  if (!container || document.querySelector(`#${EXTENSION_NAME}-panel`)) return;

  const panel = document.createElement("div");
  panel.id = `${EXTENSION_NAME}-panel`;
  panel.className = "tavernplug-panel inline-drawer";
  panel.innerHTML = `
    <div class="tavernplug-header inline-drawer-header">
      <div class="tavernplug-header-title"><i class="fa-solid fa-hand tavernplug-header-icon" aria-hidden="true"></i> HandyTavern</div>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down tavernplug-toggle" role="button" tabindex="0" aria-label="Toggle HandyTavern settings" aria-expanded="true"></div>
    </div>
    <div class="tavernplug-body inline-drawer-content">
    <div class="tavernplug-actions tavernplug-mode-switch">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-ui-basic">Basic</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-ui-advanced">Advanced</button>
    </div>
    <div class="tavernplug-bridge-warning">
      <div><strong>Important:</strong> installing the extension alone is not enough.</div>
      <div>You must install and run the local TavernPlug bridge for Handy communication. Start it with <code>npm start</code>, then click <strong>Check Bridge</strong>.</div>
    </div>
    <div class="tavernplug-setup-card">
      <div class="tavernplug-setup-eyebrow">Quick Setup</div>
      <div class="tavernplug-setup-state" id="${EXTENSION_NAME}-setup-state" data-state="neutral">Waiting for setup</div>
      <div class="tavernplug-setup-hint" id="${EXTENSION_NAME}-setup-hint">Paste your Handy Connection Key, then click Connect Device.</div>
      <div class="tavernplug-row">
        <label>Handy Connection Key</label>
        <div class="tavernplug-key-inline">
          <input class="tavernplug-key-input" type="text" name="handyConnectionKey" value="${settings.handyConnectionKey}" />
          <button class="menu_button tavernplug-sync-btn" type="button" id="${EXTENSION_NAME}-sync-test">Connect Device</button>
        </div>
      </div>
      <div class="tavernplug-actions">
        <button class="menu_button" type="button" id="${EXTENSION_NAME}-check-bridge">Check Bridge</button>
        <button class="menu_button" type="button" id="${EXTENSION_NAME}-setup-guide">Show Setup Help</button>
      </div>
      <div class="tavernplug-setup-guide-body" style="display:none;">
        <div>1. Install TavernPlug outside your SillyTavern folder.</div>
        <div>2. Run the installer script in the TavernPlug folder.</div>
        <div>3. Set HANDY_CONNECTION_KEY in .env.</div>
        <div>4. Start the local bridge with <code>npm start</code>, keep the window open, and keep it running.</div>
        <div>5. Return here, paste the same key, and click Connect Device.</div>
        <div class="tavernplug-setup-note">If the bridge stays offline, confirm the default URL is <code>http://127.0.0.1:8787</code>.</div>
      </div>
    </div>
    <div class="tavernplug-row" data-ui-mode="advanced">
      <label>Bridge URL</label>
      <input type="text" name="bridgeUrl" value="${settings.bridgeUrl}" />
    </div>
    <div class="tavernplug-row">
      <label>Global Stroke Window (0-100)</label>
      <div class="tavernplug-global-range">
        <input class="tavernplug-range-min" type="range" step="1" min="0" max="100" name="globalStrokeMinPct" value="${settings.globalStrokeMinPct}" />
        <input class="tavernplug-range-max" type="range" step="1" min="0" max="100" name="globalStrokeMaxPct" value="${settings.globalStrokeMaxPct}" />
      </div>
      <div class="tavernplug-global-range-value">${clampPercent(settings.globalStrokeMinPct)}% to ${clampPercent(settings.globalStrokeMaxPct)}%</div>
    </div>
    <div class="tavernplug-row">
      <label>Global Speed Window (0-100)</label>
      <div class="tavernplug-global-range tavernplug-speed-range">
        <input class="tavernplug-range-min" type="range" step="1" min="0" max="100" name="speedMin" value="${settings.speedMin}" />
        <input class="tavernplug-range-max" type="range" step="1" min="0" max="100" name="speedMax" value="${settings.speedMax}" />
      </div>
      <div class="tavernplug-global-range-value tavernplug-speed-range-value">${clampPercent(settings.speedMin)}% to ${clampPercent(settings.speedMax)}%</div>
    </div>
    <div class="tavernplug-actions" data-ui-mode="advanced">
      <button class="menu_button tavernplug-advanced-toggle" type="button">Advanced Settings (+)</button>
      <button class="menu_button tavernplug-speed-profiles-toggle" type="button">Speed Profiles (+)</button>
    </div>
    <div class="tavernplug-speed-profiles-body" style="display:none;" data-ui-mode="advanced">
      <div class="tavernplug-row">
        <label>Pattern Cycle Length (ms)</label>
        <input type="number" step="500" min="3000" max="120000" name="patternIntervalMs" value="${settings.patternIntervalMs}" />
      </div>
      <div class="tavernplug-row">
        <label>Gentle Speed %</label>
        <div class="tavernplug-inline">
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-gentle-down">-10</button>
          <input id="${styleSpeedInputId("gentle")}" type="number" step="1" min="0" max="100" name="testSpeedGentlePct" value="${settings.testSpeedGentlePct}" />
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-gentle-up">+10</button>
        </div>
      </div>
      <div class="tavernplug-row">
        <label>Normal Speed %</label>
        <div class="tavernplug-inline">
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-normal-down">-10</button>
          <input id="${styleSpeedInputId("normal")}" type="number" step="1" min="0" max="100" name="testSpeedNormalPct" value="${settings.testSpeedNormalPct}" />
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-normal-up">+10</button>
        </div>
      </div>
      <div class="tavernplug-row">
        <label>Brisk Speed %</label>
        <div class="tavernplug-inline">
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-brisk-down">-10</button>
          <input id="${styleSpeedInputId("brisk")}" type="number" step="1" min="0" max="100" name="testSpeedBriskPct" value="${settings.testSpeedBriskPct}" />
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-brisk-up">+10</button>
        </div>
      </div>
      <div class="tavernplug-row">
        <label>Hard Speed %</label>
        <div class="tavernplug-inline">
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-hard-down">-10</button>
          <input id="${styleSpeedInputId("hard")}" type="number" step="1" min="0" max="100" name="testSpeedHardPct" value="${settings.testSpeedHardPct}" />
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-hard-up">+10</button>
        </div>
      </div>
      <div class="tavernplug-row">
        <label>Intense Speed %</label>
        <div class="tavernplug-inline">
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-intense-down">-10</button>
          <input id="${styleSpeedInputId("intense")}" type="number" step="1" min="0" max="100" name="testSpeedIntensePct" value="${settings.testSpeedIntensePct}" />
          <button class="menu_button tavernplug-step-btn" type="button" id="${EXTENSION_NAME}-intense-up">+10</button>
        </div>
      </div>
      <div class="tavernplug-row">
        <label>Cum Button</label>
      </div>
      <div class="tavernplug-row">
        <label>Cum Stroke Length (0-100)</label>
        <input type="range" step="1" min="0" max="100" name="cumStrokePct" value="${clampPercent(settings.cumStrokePct)}" />
        <div class="tavernplug-global-range-value tavernplug-cum-stroke-value">${clampPercent(settings.cumStrokePct)}% (${cumDepthFromStrokePct(settings.cumStrokePct)})</div>
      </div>
      <div class="tavernplug-row">
        <label>Cum Button Speed (0-100)</label>
        <input type="number" step="1" min="0" max="100" name="cumSpeedPct" value="${settings.cumSpeedPct}" />
      </div>
      <div class="tavernplug-row">
        <label>Cum Button Duration (seconds)</label>
        <input type="number" step="0.25" min="0.25" max="120" name="cumDurationMs" value="${(Math.max(250, Math.min(120000, Number(settings.cumDurationMs) || 6000)) / 1000).toFixed(2).replace(/\.?0+$/, "")}" />
      </div>
    </div>
    <div class="tavernplug-advanced-body" style="display:none;" data-ui-mode="advanced">
    <div class="tavernplug-row">
      <label>Handy Native API Base URL</label>
      <input type="text" name="handyApiBaseUrl" value="${settings.handyApiBaseUrl}" />
    </div>
    <div class="tavernplug-row">
      <label>Technical Motion Settings</label>
      <div>Locked defaults: Invert Stroke OFF, Native Scale = percent, Command = xpt, Trace OFF, Native Window = 25..75</div>
    </div>
    <div class="tavernplug-row">
      <label title="Safety buffer from stroke endpoints. Higher = safer but shorter usable range.">Endpoint Safety Padding (0-20)</label>
      <input type="number" step="1" min="0" max="20" name="endpointSafetyPaddingPct" value="${settings.endpointSafetyPaddingPct}" />
    </div>
    <div class="tavernplug-row">
      <label>Native Backend</label>
      <select name="handyNativeBackend" class="tavernplug-native-select">
        <option value="thehandy" ${settings.handyNativeBackend === "thehandy" ? "selected" : ""}>thehandy wrapper (Recommended)</option>
        <option value="builtin" ${settings.handyNativeBackend === "builtin" ? "selected" : ""}>Built-in HTTP calls</option>
      </select>
    </div>
    <div class="tavernplug-row">
      <label>Message Check Interval (ms)</label>
      <input type="number" step="100" min="500" max="60000" name="pollIntervalMs" value="${settings.pollIntervalMs}" />
    </div>
    <div class="tavernplug-row">
      <label>
        <input type="checkbox" name="showDebugInfo" ${settings.showDebugInfo ? "checked" : ""} />
        Show debug status lines
      </label>
    </div>
    <div class="tavernplug-row">
      <label>
        <input type="checkbox" name="holdUntilNextCommand" ${settings.holdUntilNextCommand ? "checked" : ""} />
        Hold motion until next command
      </label>
    </div>
    </div>
    <div class="tavernplug-row">
      <!-- Add additional UI inputs here and mirror them in DEFAULTS + syncConfig(). -->
      <label title="On: LLM messages sent to Handy automatically. Off: No auto-send. Buttons/Tags/Tests only.">
        <input type="checkbox" name="autoSend" ${settings.autoSend ? "checked" : ""} />
        Auto-send latest assistant messages
      </label>
    </div>
    <div class="tavernplug-row" data-ui-mode="advanced">
      <label title="ON: cleaner command handoff, may feel slightly cut. OFF: smoother blending, but less predictable overlap.">
        <input type="checkbox" name="stopPreviousOnNewMotion" ${settings.stopPreviousOnNewMotion ? "checked" : ""} />
        Stop previous motion when a new message is sent
      </label>
    </div>
    <div class="tavernplug-actions">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-test">Test Mode Start</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-gentle">Gentle</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-normal">Normal</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-brisk">Brisk</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-hard">Hard</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-intense">Intense</button>
    </div>
    <div class="tavernplug-actions" data-ui-mode="advanced">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-wave">Wave</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-pulse">Pulse</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-ramp">Ramp</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-random">Random</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-tease">Tease</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-edging">Edging</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-burst">Burst</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-ladder">Ladder</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-stutter">Stutter</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-climax">Climax</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-pattern-stop">Stop Pattern</button>
    </div>
    <div class="tavernplug-actions" data-ui-mode="advanced">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-tip">Tip</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-middle">Middle</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-full">Full</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-deep">Deep</button>
    </div>
    <div class="tavernplug-actions">
      <button class="menu_button tavernplug-hold-on-btn" type="button" id="${EXTENSION_NAME}-hold-toggle">Hold ON</button>
      <button class="menu_button tavernplug-strict-off-btn" type="button" id="${EXTENSION_NAME}-strict-toggle">Strict OFF</button>
      <button class="menu_button tavernplug-safe-on-btn" type="button" id="${EXTENSION_NAME}-safe-toggle">Safe ON</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-park-hold">Park at 0</button>
      <button class="menu_button tavernplug-stop" type="button" id="${EXTENSION_NAME}-stop">Emergency Stop</button>
    </div>
    <div class="tavernplug-status" id="${EXTENSION_NAME}-modes">Modes</div>
    <div class="tavernplug-status" id="${EXTENSION_NAME}-health">Bridge: unknown</div>
    <div class="tavernplug-status" id="${EXTENSION_NAME}-status">Idle</div>
    </div>
  `;

  panel.querySelectorAll("input, select").forEach((element) => {
    element.addEventListener("change", onInputChange);
    if (element.tagName === "INPUT" && element.type === "range") {
      element.addEventListener("input", onInputChange);
    }
  });
  const bindClick = (suffix, handler) => {
    panel.querySelector(`#${EXTENSION_NAME}-${suffix}`)?.addEventListener("click", handler);
  };
  const bindClassClick = (selector, handler) => {
    panel.querySelector(selector)?.addEventListener("click", handler);
  };

  bindClick("test", () => { void handleTestMotion(); });
  bindClick("sync-test", () => { void handleSyncAndTestConnection(); });
  bindClick("check-bridge", () => { void handleCheckBridge(); });
  bindClick("setup-guide", () => { handleSetupGuide(); });
  bindClick("ui-basic", () => { setUiMode("basic"); });
  bindClick("ui-advanced", () => { setUiMode("advanced"); });

  const modeButtons = ["gentle", "brisk", "normal", "hard", "intense"];
  modeButtons.forEach((style) => {
    bindClick(`mode-${style}`, () => {
      stopPatternMode(false);
      void sendModeTest(style, testModeDepth);
    });
    bindClick(`${style}-down`, () => {
      adjustStyleSpeed(style, -10);
    });
    bindClick(`${style}-up`, () => {
      adjustStyleSpeed(style, 10);
    });
  });

  const patternButtons = [
    ["wave", "wave"],
    ["pulse", "pulse"],
    ["ramp", "ramp"],
    ["random", "random"],
    ["tease", "tease_hold"],
    ["edging", "edging_ramp"],
    ["burst", "pulse_bursts"],
    ["ladder", "depth_ladder"],
    ["stutter", "stutter_break"],
    ["climax", "climax_window"]
  ];
  patternButtons.forEach(([buttonSuffix, patternName]) => {
    bindClick(`pattern-${buttonSuffix}`, () => {
      void startPatternMode(patternName);
    });
  });
  bindClick("pattern-stop", () => {
    stopPatternMode();
  });

  ["tip", "middle", "full", "deep"].forEach((depth) => {
    bindClick(`depth-${depth}`, () => {
      stopPatternMode(false);
      void sendModeTest(testModeStyle, depth);
    });
  });

  bindClick("safe-toggle", () => { void toggleSafeMode(!settings.safeMode); });
  bindClick("hold-toggle", () => { void toggleHoldMode(!settings.holdUntilNextCommand); });
  bindClick("strict-toggle", () => { toggleStrictMode(!settings.strictTagOnly); });
  bindClick("stop", () => { void handleEmergencyStop(); });
  bindClick("park-hold", () => { void handleParkHold(); });

  bindClassClick(".tavernplug-advanced-toggle", () => {
    setAdvancedOpen(panel, !settings.advancedOpen);
  });
  bindClassClick(".tavernplug-speed-profiles-toggle", () => {
    setSpeedProfilesOpen(panel, !settings.speedProfilesOpen);
  });
  const togglePanelCollapsed = () => {
    setPanelCollapsed(panel, !panel.classList.contains("tavernplug-collapsed"));
  };
  panel.querySelector(".tavernplug-toggle")?.addEventListener("click", () => {
    togglePanelCollapsed();
  });
  panel.querySelector(".tavernplug-toggle")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePanelCollapsed();
    }
  });
  panel.querySelector(".tavernplug-header")?.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,input,select,textarea,label,a")) return;
    togglePanelCollapsed();
  });
  setAdvancedOpen(panel, settings.advancedOpen);
  setSpeedProfilesOpen(panel, settings.speedProfilesOpen);
  setPanelCollapsed(panel, settings.panelCollapsed);
  updateGlobalStrokeSlider(panel);
  updateGlobalSpeedSlider(panel);
  updateCumStrokeValue(panel);

  container.append(panel);
  setupStateEl = panel.querySelector(`#${EXTENSION_NAME}-setup-state`);
  setupHintEl = panel.querySelector(`#${EXTENSION_NAME}-setup-hint`);
  modeStateEl = panel.querySelector(`#${EXTENSION_NAME}-modes`);
  healthEl = panel.querySelector(`#${EXTENSION_NAME}-health`);
  statusEl = panel.querySelector(`#${EXTENSION_NAME}-status`);
  setSetupGuideOpen(panel, settings.setupGuideOpen);
  updateUiModeControls(panel);
  updateBridgeWarning(panel);
  setSetupState(
    hasConfiguredConnectionKey() ? "Checking setup" : "Waiting for setup",
    hasConfiguredConnectionKey()
      ? "Click Connect Device to verify the bridge and your Handy."
      : "Paste your Handy Connection Key, then click Connect Device.",
    "neutral"
  );
  updateModeStateLine();
  updateHoldButton();
  updateStrictButton();
  updateSafeButtons();
  applyDebugVisibility();
  updateQuickPauseButton();
}

function ensurePanelMounted() {
  renderSettingsPanel();
  if (document.querySelector(`#${EXTENSION_NAME}-panel`)) {
    if (panelRetryHandle) {
      clearInterval(panelRetryHandle);
      panelRetryHandle = null;
    }
    return;
  }

  if (!panelRetryHandle) {
    panelRetryHandle = setInterval(() => {
      renderSettingsPanel();
      if (document.querySelector(`#${EXTENSION_NAME}-panel`)) {
        clearInterval(panelRetryHandle);
        panelRetryHandle = null;
      }
    }, 1000);
  }
}

function mountQuickStopButton() {
  if (
    document.querySelector(`#${EXTENSION_NAME}-quick-pause`)
    && document.querySelector(`#${EXTENSION_NAME}-quick-cum`)
  ) return true;

  const cumButton = document.createElement("button");
  cumButton.id = `${EXTENSION_NAME}-quick-cum`;
  cumButton.type = "button";
  cumButton.className = "menu_button tavernplug-quick-cum";
  cumButton.textContent = "Cum";
  cumButton.title = "Run user-configured cum action";
  cumButton.addEventListener("click", () => {
    void handleCumAction();
  });

  const pauseButton = document.createElement("button");
  pauseButton.id = `${EXTENSION_NAME}-quick-pause`;
  pauseButton.type = "button";
  pauseButton.className = "menu_button tavernplug-quick-pause";
  pauseButton.textContent = settings.paused ? "Resume" : "Pause";
  pauseButton.title = "Pause/resume all TavernPlug motion actions";
  pauseButton.addEventListener("click", () => {
    void togglePause();
  });

  const container = findQuickStopContainer();
  if (container) {
    pauseButton.classList.add("tavernplug-quick-stop-inline");
    cumButton.classList.add("tavernplug-quick-stop-inline");
    container.append(pauseButton);
    container.append(cumButton);
    updateQuickPauseButton();
    return true;
  }

  pauseButton.classList.add("tavernplug-quick-pause-floating");
  cumButton.classList.add("tavernplug-quick-cum-floating");
  document.body.append(pauseButton);
  document.body.append(cumButton);
  updateQuickPauseButton();
  return true;
}

function ensureQuickStopMounted() {
  mountQuickStopButton();
  if (!quickStopRetryHandle) {
    quickStopRetryHandle = setInterval(() => {
      if (!document.body) return;
      mountQuickStopButton();
    }, 1500);
  }
}

function startPolling() {
  if (pollHandle) return;
  const intervalMs = Math.max(500, Math.min(60000, Number(settings.pollIntervalMs) || 3000));
  pollHandle = setInterval(() => {
    const message = getAssistantMessageFromContext();
    void sendMotionIfNeeded(message);
  }, intervalMs);
}

function startHealthPolling() {
  if (healthHandle || healthPollingPaused) return;
  const run = async () => {
    try {
      const health = await fetchHealth();
      bridgeHealthDetected = true;
      updateBridgeWarning();
      healthFailureCount = 0;
      const connected = health?.controller?.connected ? "connected" : "disconnected";
      const device = health?.controller?.selectedDevice || "none";
      const active = health?.motionLikelyActive ? "active" : "idle";
      const mode = health?.controllerMode || settings.controllerMode || "buttplug";
      const hsp = health?.hspState;
      const nativeProtocol = String(health?.handyNativeProtocol || settings.handyNativeProtocol || "hamp").toLowerCase();
      const hspBits = hsp && typeof hsp === "object"
        ? ` | HSP: state=${hsp.play_state ?? "?"} loop=${hsp.loop ?? "?"} rate=${hsp.playback_rate ?? "?"}`
        : "";
      const depthBits = mode === "handy-native" && nativeProtocol === "hamp"
        ? " | Depth: limited (HAMP mode)"
        : "";
      setHealth(`Bridge: ${connected} | Mode: ${mode} | Device: ${device} | Motion: ${active}${hspBits}${depthBits}`);
      setSyncButtonConnected(Boolean(health?.controller?.connected));
      if (health?.controller?.connected && hasConfiguredConnectionKey()) {
        setSetupState("Ready", `Connected to ${device}. Motion control is ready.`, "ok");
      } else {
        setSetupState(
          "Bridge reachable",
          hasConfiguredConnectionKey()
            ? "Bridge is online. Click Connect Device after entering your Handy key."
            : "Bridge is online, but your Handy Connection Key is still empty.",
          "warn"
        );
      }
    } catch (error) {
      healthFailureCount += 1;
      setHealth("Bridge: offline");
      setSyncButtonConnected(false);
      setSetupState(
        "Bridge offline",
        "The local bridge is not responding. Start it with npm start, then retry.",
        "error"
      );
      if (healthFailureCount >= 5) {
        if (healthHandle) {
          clearInterval(healthHandle);
          healthHandle = null;
        }
        healthPollingPaused = true;
        setHealth("Bridge: offline (health polling paused)");
        setStatus("Health polling paused after repeated failures. Click Sync Config to retry.");
      }
    }
  };
  healthHandle = setInterval(() => {
    void run();
  }, 12000);
  void run();
}

function restartPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  startPolling();
}

function init() {
  if (!getContextSafe()) {
    // eslint-disable-next-line no-console
    console.error("[tavernplug-handy] SillyTavern context is unavailable");
    return;
  }
  ensurePanelMounted();
  ensureQuickStopMounted();
  startPolling();
  startHealthPolling();
  void syncConfig();
}

jQuery(() => {
  init();
});
