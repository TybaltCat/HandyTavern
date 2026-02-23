const EXTENSION_NAME = "tavernplug-handy";
// Add new extension-level settings defaults here.
const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8787",
  autoSend: true,
  strictTagOnly: true,
  holdUntilNextCommand: false,
  stopPreviousOnNewMotion: true,
  panelCollapsed: false,
  safeMode: false,
  safeMaxSpeed: 60,
  safeMaxDurationMs: 4000,
  testSpeedGentlePct: 20,
  testSpeedBriskPct: 40,
  testSpeedNormalPct: 55,
  testSpeedHardPct: 75,
  testSpeedIntensePct: 90,
  handyConnectionKey: "",
  strokeRange: 100,
  speedMin: 0,
  speedMax: 100,
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
extensionSettingsStore[EXTENSION_NAME] = settings;

let lastSentMessageId = -1;
let pollHandle = null;
let statusEl = null;
let panelRetryHandle = null;
let testModeActive = false;
let testModeStyle = "normal";
let testModeDepth = "middle";
let preTestHoldSetting = null;

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

function messageHasMotionTag(text) {
  return /\[motion:\s*[^\]]+\]/i.test(text);
}

function findSettingsContainer() {
  return (
    document.querySelector("#extensions_settings") ||
    document.querySelector("#extensions_settings2") ||
    document.querySelector(".extensions_settings")
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
    strokeRange: clampPercent(settings.strokeRange) / 100,
    speedMin: clampPercent(settings.speedMin) / 100,
    speedMax: clampPercent(settings.speedMax) / 100,
    minimumAllowedStroke: clampPercent(settings.minimumAllowedStroke) / 100,
    safeMode: Boolean(settings.safeMode),
    safeMaxSpeed: clampPercent(settings.safeMaxSpeed) / 100,
    safeMaxDurationMs: Math.max(250, Number(settings.safeMaxDurationMs) || 4000),
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
  if (message.id <= lastSentMessageId) return;
  if (settings.strictTagOnly && !messageHasMotionTag(message.text)) return;

  try {
    await postJson("/motion", { text: message.text });
    lastSentMessageId = message.id;
    setStatus(`Sent message ${message.id}`);
  } catch (error) {
    setStatus(`Motion error: ${error.message}`);
  }
}

function onInputChange(event) {
  const { name, type } = event.target;
  if (!name || !Object.prototype.hasOwnProperty.call(settings, name)) return;

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
      "testSpeedIntensePct"
    ].includes(name)
  ) {
    settings[name] = clampPercent(settings[name]);
  }
  if (type === "number" && name === "safeMaxDurationMs") {
    settings[name] = Math.max(250, Number(settings[name]) || 4000);
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
    "testSpeedIntensePct"
  ].includes(name);
  saveSettings();
  // Any UI setting change is pushed to the local bridge immediately.
  void syncConfig();
  if (testModeActive && isLiveMotionControl) {
    // Re-send current mode so live adjustments apply immediately.
    setTimeout(() => {
      void sendModeTest(testModeStyle, testModeDepth);
    }, 150);
  }
}

async function handleEmergencyStop() {
  try {
    await postJson("/emergency-stop", {});
    setStatus("Emergency stop sent");
  } catch (error) {
    setStatus(`Stop error: ${error.message}`);
  }
}

async function handleTestMotion() {
  const testButton = document.querySelector(`#${EXTENSION_NAME}-test`);

  if (!testModeActive) {
    preTestHoldSetting = Boolean(settings.holdUntilNextCommand);
    settings.holdUntilNextCommand = true;
    saveSettings();
    await syncConfig();
    testModeActive = true;
    if (testButton) testButton.textContent = "Test Mode Stop";
    await sendModeTest(testModeStyle, testModeDepth);
    setStatus("Test mode started");
    return;
  }

  try {
    await postJson("/emergency-stop", {});
    if (preTestHoldSetting !== null) {
      settings.holdUntilNextCommand = preTestHoldSetting;
      preTestHoldSetting = null;
      saveSettings();
      await syncConfig();
    }
    testModeActive = false;
    if (testButton) testButton.textContent = "Test Mode Start";
    setStatus("Test mode stopped");
  } catch (error) {
    setStatus(`Test error: ${error.message}`);
  }
}

function currentTestSpeed() {
  const min = clampPercent(settings.speedMin);
  const max = clampPercent(settings.speedMax);
  if (max < min) return min;
  return Math.round((min + max) / 2);
}

function speedSettingKeyForStyle(style) {
  if (style === "gentle") return "testSpeedGentlePct";
  if (style === "brisk") return "testSpeedBriskPct";
  if (style === "hard") return "testSpeedHardPct";
  if (style === "intense") return "testSpeedIntensePct";
  return "testSpeedNormalPct";
}

function currentStyleSpeed(style) {
  const min = clampPercent(settings.speedMin);
  const max = clampPercent(settings.speedMax);
  if (max < min) return min;

  const stylePct = clampPercent(settings[speedSettingKeyForStyle(style)]);
  const clamped = Math.max(min, Math.min(max, stylePct));
  return Math.round(clamped);
}

async function sendModeTest(style, depth) {
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
  settings.safeMode = Boolean(enabled);
  saveSettings();
  await syncConfig();
  setStatus(`Safe Mode ${settings.safeMode ? "ON" : "OFF"}`);
}

async function toggleHoldMode(enabled) {
  settings.holdUntilNextCommand = Boolean(enabled);
  saveSettings();
  await syncConfig();
  setStatus(`Hold Until Next Command ${settings.holdUntilNextCommand ? "ON" : "OFF"}`);
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
      <label>Stroke Range (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="strokeRange" value="${settings.strokeRange}" />
    </div>
    <div class="tavernplug-row">
      <label>Minimum Allowed Stroke (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="minimumAllowedStroke" value="${settings.minimumAllowedStroke}" />
    </div>
    <div class="tavernplug-row">
      <label>Speed Range Min (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="speedMin" value="${settings.speedMin}" />
    </div>
    <div class="tavernplug-row">
      <label>Speed Range Max (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="speedMax" value="${settings.speedMax}" />
    </div>
    <div class="tavernplug-row">
      <label>Safe Max Speed (0-100)</label>
      <input type="number" step="1" min="0" max="100" name="safeMaxSpeed" value="${settings.safeMaxSpeed}" />
    </div>
    <div class="tavernplug-row">
      <label>Safe Max Duration (ms)</label>
      <input type="number" step="100" min="250" name="safeMaxDurationMs" value="${settings.safeMaxDurationMs}" />
    </div>
    <div class="tavernplug-row">
      <label>Gentle Speed %</label>
      <input type="number" step="1" min="0" max="100" name="testSpeedGentlePct" value="${settings.testSpeedGentlePct}" />
    </div>
    <div class="tavernplug-row">
      <label>Brisk Speed %</label>
      <input type="number" step="1" min="0" max="100" name="testSpeedBriskPct" value="${settings.testSpeedBriskPct}" />
    </div>
    <div class="tavernplug-row">
      <label>Normal Speed %</label>
      <input type="number" step="1" min="0" max="100" name="testSpeedNormalPct" value="${settings.testSpeedNormalPct}" />
    </div>
    <div class="tavernplug-row">
      <label>Hard Speed %</label>
      <input type="number" step="1" min="0" max="100" name="testSpeedHardPct" value="${settings.testSpeedHardPct}" />
    </div>
    <div class="tavernplug-row">
      <label>Intense Speed %</label>
      <input type="number" step="1" min="0" max="100" name="testSpeedIntensePct" value="${settings.testSpeedIntensePct}" />
    </div>
    <div class="tavernplug-row">
      <!-- Add additional UI inputs here and mirror them in DEFAULTS + syncConfig(). -->
      <label>
        <input type="checkbox" name="autoSend" ${settings.autoSend ? "checked" : ""} />
        Auto-send latest assistant messages
      </label>
      <label>
        <input type="checkbox" name="strictTagOnly" ${settings.strictTagOnly ? "checked" : ""} />
        Only send messages containing [motion: ...]
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
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-brisk">Brisk</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-normal">Normal</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-hard">Hard</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-mode-intense">Intense</button>
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
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-safe-on">Safe ON</button>
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-safe-off">Safe OFF</button>
      <button class="menu_button tavernplug-stop" type="button" id="${EXTENSION_NAME}-stop">Emergency Stop</button>
    </div>
    <div class="tavernplug-status" id="${EXTENSION_NAME}-status">Idle</div>
    </div>
  `;

  panel.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", onInputChange);
  });
  panel.querySelector(`#${EXTENSION_NAME}-test`)?.addEventListener("click", () => {
    void handleTestMotion();
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-gentle`)?.addEventListener("click", () => {
    void sendModeTest("gentle", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-brisk`)?.addEventListener("click", () => {
    void sendModeTest("brisk", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-normal`)?.addEventListener("click", () => {
    void sendModeTest("normal", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-hard`)?.addEventListener("click", () => {
    void sendModeTest("hard", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-mode-intense`)?.addEventListener("click", () => {
    void sendModeTest("intense", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-tip`)?.addEventListener("click", () => {
    void sendModeTest("normal", "tip");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-middle`)?.addEventListener("click", () => {
    void sendModeTest("normal", "middle");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-full`)?.addEventListener("click", () => {
    void sendModeTest("normal", "full");
  });
  panel.querySelector(`#${EXTENSION_NAME}-depth-deep`)?.addEventListener("click", () => {
    void sendModeTest("normal", "deep");
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
  panel.querySelector(`#${EXTENSION_NAME}-stop`)?.addEventListener("click", () => {
    void handleEmergencyStop();
  });
  panel.querySelector(".tavernplug-toggle")?.addEventListener("click", () => {
    setPanelCollapsed(panel, !panel.classList.contains("tavernplug-collapsed"));
  });
  setPanelCollapsed(panel, settings.panelCollapsed);

  container.append(panel);
  statusEl = panel.querySelector(`#${EXTENSION_NAME}-status`);
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

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    const message = getAssistantMessageFromContext();
    void sendMotionIfNeeded(message);
  }, 800);
}

function init() {
  if (!getContextSafe()) {
    // eslint-disable-next-line no-console
    console.error("[tavernplug-handy] SillyTavern context is unavailable");
    return;
  }
  ensurePanelMounted();
  startPolling();
  void syncConfig();
}

jQuery(() => {
  init();
});
