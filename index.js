const EXTENSION_NAME = "tavernplug-handy";
// Add new extension-level settings defaults here.
const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8787",
  pollIntervalMs: 2000,
  autoSend: true,
  paused: false,
  strictTagOnly: false,
  advancedOpen: false,
  holdUntilNextCommand: true,
  stopPreviousOnNewMotion: true,
  panelCollapsed: false,
  safeMode: true,
  safeMaxSpeed: 75,
  patternIntervalMs: 1800,
  cumStyle: "intense",
  cumDepth: "deep",
  cumSpeedPct: 75,
  cumDurationMs: 6000,
  testSpeedGentlePct: 20,
  testSpeedBriskPct: 55,
  testSpeedNormalPct: 40,
  testSpeedHardPct: 75,
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
  minimumAllowedStroke: 0
};

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
// Migrate older default profile where brisk was slower than normal.
if (Number(settings.testSpeedBriskPct) === 40 && Number(settings.testSpeedNormalPct) === 55) {
  settings.testSpeedBriskPct = 55;
  settings.testSpeedNormalPct = 40;
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
normalizePercentSetting("cumSpeedPct");
normalizePercentSetting("globalStrokeMinPct");
normalizePercentSetting("globalStrokeMaxPct");
normalizePercentSetting("physicalMinPct");
normalizePercentSetting("physicalMaxPct");
extensionSettingsStore[EXTENSION_NAME] = settings;

let lastSentMessageId = -1;
let lastSentMessageSignature = "";
let pollHandle = null;
let healthHandle = null;
let statusEl = null;
let modeStateEl = null;
let healthEl = null;
let panelRetryHandle = null;
let testModeActive = false;
let testModeStyle = "normal";
let testModeDepth = "middle";
let preTestHoldSetting = null;
let patternIntervalHandle = null;
let activePatternName = null;
let patternStep = 0;
let quickStopRetryHandle = null;
let lastObservedMessageId = -1;
let lastObservedMessageText = "";
let lastObservedMessageChangedAt = 0;

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

function updateModeStateLine() {
  if (!modeStateEl) return;
  modeStateEl.textContent = [
    `Paused: ${settings.paused ? "ON" : "OFF"}`,
    `Strict: ${settings.strictTagOnly ? "ON" : "OFF"}`,
    `Hold: ${settings.holdUntilNextCommand ? "ON" : "OFF"}`,
    `Safe: ${settings.safeMode ? "ON" : "OFF"}`,
    `Test: ${testModeActive ? "ON" : "OFF"}`,
    `Pattern: ${activePatternName ?? "OFF"}`
  ].join(" | ");
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
    handyConnectionKey: String(settings.handyConnectionKey ?? ""),
    globalStrokeMin: clampPercent(settings.globalStrokeMinPct) / 100,
    globalStrokeMax: clampPercent(settings.globalStrokeMaxPct) / 100,
    physicalMin: clampPercent(settings.physicalMinPct) / 100,
    physicalMax: clampPercent(settings.physicalMaxPct) / 100,
    invertStroke: Boolean(settings.invertStroke),
    strokeRange: clampPercent(settings.strokeRange) / 100,
    speedMin: clampPercent(settings.speedMin) / 100,
    speedMax: clampPercent(settings.speedMax) / 100,
    minimumAllowedStroke: clampPercent(settings.minimumAllowedStroke) / 100,
    safeMode: Boolean(settings.safeMode),
    safeMaxSpeed: clampPercent(settings.safeMaxSpeed) / 100,
    strictMotionTag: Boolean(settings.strictTagOnly),
    holdUntilNextCommand: Boolean(settings.holdUntilNextCommand),
    stopPreviousOnNewMotion: Boolean(settings.stopPreviousOnNewMotion)
  };

  try {
    await postJson("/config", payload);
    setStatus("Config synced");
  } catch (error) {
    setStatus(`Config error: ${error.message}. Is bridge running on ${settings.bridgeUrl}?`);
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
    await postJson("/motion", { text: message.text });
    lastSentMessageId = message.id;
    lastSentMessageSignature = signature;
    setStatus(`Sent message ${message.id}`);
  } catch (error) {
    setStatus(`Motion error: ${error.message}`);
  }
}

function onInputChange(event) {
  const { name, type } = event.target;
  if (!name || !Object.prototype.hasOwnProperty.call(settings, name)) return;

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
      "physicalMaxPct"
    ].includes(name)
  ) {
    settings[name] = clampPercent(settings[name]);
  }
  if (name === "safeMaxSpeed") {
    settings[name] = Math.min(75, clampPercent(settings[name]));
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
    settings[name] = Math.max(300, Math.min(15000, Number(settings[name]) || 1800));
  }
  if (type === "number" && name === "cumDurationMs") {
    settings[name] = Math.max(250, Math.min(120000, Number(settings[name]) || 6000));
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
    "physicalMaxPct"
  ].includes(name);
  const panel = document.querySelector(`#${EXTENSION_NAME}-panel`);
  if (name === "globalStrokeMinPct" || name === "globalStrokeMaxPct") {
    updateGlobalStrokeSlider(panel);
  }
  if (name === "speedMin" || name === "speedMax") {
    updateGlobalSpeedSlider(panel);
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
      setStatus("Paused: motion stopped");
    } catch (error) {
      setStatus(`Pause error: ${error.message}`);
    }
    return;
  }
  setStatus("Resumed");
}

async function handleParkHold() {
  if (settings.paused) {
    setStatus("Paused: park action blocked");
    return;
  }
  try {
    stopPatternMode(false);
    await postJson("/park-hold", {});
    setStatus("Parked at 0 until next command");
  } catch (error) {
    setStatus(`Park error: ${error.message}`);
  }
}

function clampCumStyle(raw) {
  const value = String(raw ?? "").toLowerCase();
  const allowed = ["gentle", "normal", "brisk", "hard", "intense"];
  return allowed.includes(value) ? value : "intense";
}

function clampCumDepth(raw) {
  const value = String(raw ?? "").toLowerCase();
  const allowed = ["tip", "middle", "full", "deep"];
  return allowed.includes(value) ? value : "deep";
}

async function handleCumAction() {
  if (settings.paused) {
    setStatus("Paused: cum action blocked");
    return;
  }
  const style = clampCumStyle(settings.cumStyle);
  const depth = clampCumDepth(settings.cumDepth);
  const speed = clampPercent(settings.cumSpeedPct);
  const durationMs = Math.max(250, Math.min(120000, Number(settings.cumDurationMs) || 6000));
  const durationSec = (durationMs / 1000).toFixed(2).replace(/\.00$/, "");
  const tag = `[motion: style=${style} speed=${speed} depth=${depth} duration=${durationSec}s]`;
  try {
    stopPatternMode(false);
    await postJson("/motion", { text: tag });
    setStatus(`Cum action sent: ${style}/${depth} @ ${speed}%`);
  } catch (error) {
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
  if (patternIntervalHandle) {
    clearInterval(patternIntervalHandle);
    patternIntervalHandle = null;
  }
  activePatternName = null;
  patternStep = 0;
  updateModeStateLine();
  if (updateStatus) setStatus("Pattern stopped");
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

async function startPatternMode(name) {
  if (settings.paused) {
    setStatus("Paused: pattern blocked");
    return;
  }
  if (!testModeActive) {
    await startTestMode();
  }
  stopPatternMode(false);
  activePatternName = name;
  patternStep = 0;
  updateModeStateLine();

  const tick = async () => {
    const frame = nextPatternFrame(name, patternStep);
    await sendModeTest(frame.style, frame.depth);
  };

  await tick();
  const intervalMs = Math.max(
    300,
    Math.min(15000, Number(settings.patternIntervalMs) || 1800)
  );
  patternIntervalHandle = setInterval(() => {
    patternStep += 1;
    void tick();
  }, intervalMs);
  setStatus(`Pattern running: ${name} @ ${intervalMs}ms`);
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

async function sendModeTest(style, depth) {
  if (settings.paused) {
    setStatus("Paused: mode test blocked");
    return;
  }
  testModeStyle = style;
  testModeDepth = depth;
  const speed = currentStyleSpeed(style);
  const testTag = `[motion: style=${style} speed=${speed} depth=${depth} duration=3s]`;
  try {
    await postJson("/motion", { text: testTag });
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
  setStatus(`Safe Mode ${settings.safeMode ? "ON" : "OFF"}`);
}

async function toggleHoldMode(enabled) {
  settings.holdUntilNextCommand = Boolean(enabled);
  saveSettings();
  await syncConfig();
  updateModeStateLine();
  setStatus(`Hold Until Next Command ${settings.holdUntilNextCommand ? "ON" : "OFF"}`);
}

function toggleStrictMode(enabled) {
  settings.strictTagOnly = Boolean(enabled);
  saveSettings();
  updateModeStateLine();
  setStatus(`Strict Tags ${settings.strictTagOnly ? "ON" : "OFF"}`);
}

function setPanelCollapsed(panel, collapsed) {
  settings.panelCollapsed = Boolean(collapsed);
  panel.classList.toggle("tavernplug-collapsed", settings.panelCollapsed);
  const toggle = panel.querySelector(".tavernplug-toggle");
  if (toggle) toggle.textContent = settings.panelCollapsed ? "+" : "-";
  saveSettings();
}

function renderSettingsPanel() {
  const container = findSettingsContainer();
  if (!container || document.querySelector(`#${EXTENSION_NAME}-panel`)) return;

  const panel = document.createElement("div");
  panel.id = `${EXTENSION_NAME}-panel`;
  panel.className = "tavernplug-panel";
  panel.innerHTML = `
    <div class="tavernplug-header">
      <h4>HandyTavern</h4>
      <button class="menu_button tavernplug-toggle" type="button">-</button>
    </div>
    <div class="tavernplug-body">
    <div class="tavernplug-row">
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
    <div class="tavernplug-row">
      <label>Physical Stroke Window (0-100)</label>
      <div class="tavernplug-inline">
        <input type="number" step="1" min="0" max="100" name="physicalMinPct" value="${settings.physicalMinPct}" />
        <span>to</span>
        <input type="number" step="1" min="0" max="100" name="physicalMaxPct" value="${settings.physicalMaxPct}" />
      </div>
      <label>
        <input type="checkbox" name="invertStroke" ${settings.invertStroke ? "checked" : ""} />
        Invert Stroke Direction
      </label>
    </div>
    <div class="tavernplug-row">
      <label>Pattern Interval (ms)</label>
      <input type="number" step="100" min="300" max="15000" name="patternIntervalMs" value="${settings.patternIntervalMs}" />
    </div>
    <div class="tavernplug-row">
      <button class="menu_button tavernplug-advanced-toggle" type="button">Advanced Settings (+)</button>
    </div>
    <div class="tavernplug-advanced-body" style="display:none;">
    <div class="tavernplug-row">
      <label>Cum Button Style</label>
      <select name="cumStyle">
        <option value="gentle" ${settings.cumStyle === "gentle" ? "selected" : ""}>Gentle</option>
        <option value="normal" ${settings.cumStyle === "normal" ? "selected" : ""}>Normal</option>
        <option value="brisk" ${settings.cumStyle === "brisk" ? "selected" : ""}>Brisk</option>
        <option value="hard" ${settings.cumStyle === "hard" ? "selected" : ""}>Hard</option>
        <option value="intense" ${settings.cumStyle === "intense" ? "selected" : ""}>Intense</option>
      </select>
    </div>
    <div class="tavernplug-row">
      <label>Cum Button Depth</label>
      <select name="cumDepth">
        <option value="tip" ${settings.cumDepth === "tip" ? "selected" : ""}>Tip</option>
        <option value="middle" ${settings.cumDepth === "middle" ? "selected" : ""}>Middle</option>
        <option value="full" ${settings.cumDepth === "full" ? "selected" : ""}>Full</option>
        <option value="deep" ${settings.cumDepth === "deep" ? "selected" : ""}>Deep</option>
      </select>
    </div>
    <div class="tavernplug-row">
      <label>Cum Button Speed (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="cumSpeedPct" value="${settings.cumSpeedPct}" />
    </div>
    <div class="tavernplug-row">
      <label>Cum Button Duration (ms)</label>
      <input type="number" step="100" min="250" max="120000" name="cumDurationMs" value="${settings.cumDurationMs}" />
    </div>
    <div class="tavernplug-row">
      <label>Message Check Interval (ms)</label>
      <input type="number" step="100" min="500" max="60000" name="pollIntervalMs" value="${settings.pollIntervalMs}" />
    </div>
    <div class="tavernplug-row">
      <label>Stroke Range (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="strokeRange" value="${settings.strokeRange}" />
    </div>
    <div class="tavernplug-row">
      <label>Minimum Allowed Stroke (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="minimumAllowedStroke" value="${settings.minimumAllowedStroke}" />
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
    </div>
    <div class="tavernplug-row">
      <!-- Add additional UI inputs here and mirror them in DEFAULTS + syncConfig(). -->
      <label>
        <input type="checkbox" name="autoSend" ${settings.autoSend ? "checked" : ""} />
        Auto-send latest assistant messages
      </label>
      <label>
        <input type="checkbox" name="stopPreviousOnNewMotion" ${settings.stopPreviousOnNewMotion ? "checked" : ""} />
        Stop previous motion when a new message is sent
      </label>
      <label>
        <input type="checkbox" name="holdUntilNextCommand" ${settings.holdUntilNextCommand ? "checked" : ""} />
        Hold motion until next command
      </label>
      <label>
        <input type="checkbox" name="safeMode" ${settings.safeMode ? "checked" : ""} />
        Safe Mode
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
    <div class="tavernplug-actions">
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
    <div class="tavernplug-actions">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-tip">Tip</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-middle">Middle</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-full">Full</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-depth-deep">Deep</button>
    </div>
    <div class="tavernplug-actions">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-hold-on">Hold ON</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-hold-off">Hold OFF</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-strict-on">Strict ON</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-strict-off">Strict OFF</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-safe-on">Safe ON</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-safe-off">Safe OFF</button>
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
  panel.querySelector(`#${EXTENSION_NAME}-test`)?.addEventListener("click", () => {
    void handleTestMotion();
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-gentle`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest("gentle", testModeDepth);
  });
  panel.querySelector(`#${EXTENSION_NAME}-gentle-down`)?.addEventListener("click", () => {
    adjustStyleSpeed("gentle", -10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-gentle-up`)?.addEventListener("click", () => {
    adjustStyleSpeed("gentle", 10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-brisk`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest("brisk", testModeDepth);
  });
  panel.querySelector(`#${EXTENSION_NAME}-brisk-down`)?.addEventListener("click", () => {
    adjustStyleSpeed("brisk", -10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-brisk-up`)?.addEventListener("click", () => {
    adjustStyleSpeed("brisk", 10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-normal`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest("normal", testModeDepth);
  });
  panel.querySelector(`#${EXTENSION_NAME}-normal-down`)?.addEventListener("click", () => {
    adjustStyleSpeed("normal", -10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-normal-up`)?.addEventListener("click", () => {
    adjustStyleSpeed("normal", 10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-hard`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest("hard", testModeDepth);
  });
  panel.querySelector(`#${EXTENSION_NAME}-hard-down`)?.addEventListener("click", () => {
    adjustStyleSpeed("hard", -10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-hard-up`)?.addEventListener("click", () => {
    adjustStyleSpeed("hard", 10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-intense`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest("intense", testModeDepth);
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-wave`)?.addEventListener("click", () => {
    void startPatternMode("wave");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-pulse`)?.addEventListener("click", () => {
    void startPatternMode("pulse");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-ramp`)?.addEventListener("click", () => {
    void startPatternMode("ramp");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-random`)?.addEventListener("click", () => {
    void startPatternMode("random");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-tease`)?.addEventListener("click", () => {
    void startPatternMode("tease_hold");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-edging`)?.addEventListener("click", () => {
    void startPatternMode("edging_ramp");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-burst`)?.addEventListener("click", () => {
    void startPatternMode("pulse_bursts");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-ladder`)?.addEventListener("click", () => {
    void startPatternMode("depth_ladder");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-stutter`)?.addEventListener("click", () => {
    void startPatternMode("stutter_break");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-climax`)?.addEventListener("click", () => {
    void startPatternMode("climax_window");
  });
  panel.querySelector(`#${EXTENSION_NAME}-pattern-stop`)?.addEventListener("click", () => {
    stopPatternMode();
  });
  panel.querySelector(`#${EXTENSION_NAME}-intense-down`)?.addEventListener("click", () => {
    adjustStyleSpeed("intense", -10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-intense-up`)?.addEventListener("click", () => {
    adjustStyleSpeed("intense", 10);
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-tip`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest(testModeStyle, "tip");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-middle`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest(testModeStyle, "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-full`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest(testModeStyle, "full");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-deep`)?.addEventListener("click", () => {
    stopPatternMode(false);
    void sendModeTest(testModeStyle, "deep");
  });
  panel.querySelector(`#${EXTENSION_NAME}-safe-on`)?.addEventListener("click", () => {
    void toggleSafeMode(true);
  });
  panel.querySelector(`#${EXTENSION_NAME}-safe-off`)?.addEventListener("click", () => {
    void toggleSafeMode(false);
  });
  panel.querySelector(`#${EXTENSION_NAME}-hold-on`)?.addEventListener("click", () => {
    void toggleHoldMode(true);
  });
  panel.querySelector(`#${EXTENSION_NAME}-hold-off`)?.addEventListener("click", () => {
    void toggleHoldMode(false);
  });
  panel.querySelector(`#${EXTENSION_NAME}-strict-on`)?.addEventListener("click", () => {
    toggleStrictMode(true);
  });
  panel.querySelector(`#${EXTENSION_NAME}-strict-off`)?.addEventListener("click", () => {
    toggleStrictMode(false);
  });
  panel.querySelector(`#${EXTENSION_NAME}-stop`)?.addEventListener("click", () => {
    void handleEmergencyStop();
  });
  panel.querySelector(`#${EXTENSION_NAME}-park-hold`)?.addEventListener("click", () => {
    void handleParkHold();
  });
  panel.querySelector(".tavernplug-advanced-toggle")?.addEventListener("click", () => {
    setAdvancedOpen(panel, !settings.advancedOpen);
  });
  panel.querySelector(".tavernplug-toggle")?.addEventListener("click", () => {
    setPanelCollapsed(panel, !panel.classList.contains("tavernplug-collapsed"));
  });
  setAdvancedOpen(panel, settings.advancedOpen);
  setPanelCollapsed(panel, settings.panelCollapsed);
  updateGlobalStrokeSlider(panel);
  updateGlobalSpeedSlider(panel);

  container.append(panel);
  modeStateEl = panel.querySelector(`#${EXTENSION_NAME}-modes`);
  healthEl = panel.querySelector(`#${EXTENSION_NAME}-health`);
  statusEl = panel.querySelector(`#${EXTENSION_NAME}-status`);
  updateModeStateLine();
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
  if (healthHandle) return;
  const run = async () => {
    try {
      const health = await fetchHealth();
      const connected = health?.controller?.connected ? "connected" : "disconnected";
      const device = health?.controller?.selectedDevice || "none";
      const active = health?.motionLikelyActive ? "active" : "idle";
      setHealth(`Bridge: ${connected} | Device: ${device} | Motion: ${active}`);
    } catch (_error) {
      setHealth("Bridge: offline");
    }
  };
  healthHandle = setInterval(() => {
    void run();
  }, 4000);
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
