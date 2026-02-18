import {
  extension_settings,
  getContext,
  saveSettingsDebounced
} from "../../../extensions.js";

const EXTENSION_NAME = "tavernplug-handy";
// Add new extension-level settings defaults here.
const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8787",
  autoSend: true,
  strictTagOnly: true,
  stopPreviousOnNewMotion: true,
  handyConnectionKey: "",
  strokeRange: 1,
  speedMin: 0,
  speedMax: 1,
  minimumAllowedStroke: 0
};

const settings = extension_settings[EXTENSION_NAME] ?? {};
Object.assign(settings, DEFAULTS, settings);
extension_settings[EXTENSION_NAME] = settings;

let lastSentMessageId = -1;
let pollHandle = null;
let statusEl = null;

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function messageHasMotionTag(text) {
  return /\[motion:\s*[^\]]+\]/i.test(text);
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
  const context = getContext();
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
    strokeRange: clamp01(settings.strokeRange),
    speedMin: clamp01(settings.speedMin),
    speedMax: clamp01(settings.speedMax),
    minimumAllowedStroke: clamp01(settings.minimumAllowedStroke),
    stopPreviousOnNewMotion: Boolean(settings.stopPreviousOnNewMotion)
  };

  try {
    await postJson("/config", payload);
    setStatus("Config synced");
  } catch (error) {
    setStatus(`Config error: ${error.message}`);
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
  saveSettingsDebounced();
  // Any UI setting change is pushed to the local bridge immediately.
  void syncConfig();
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
  // Adjust this canned tag to test different parser/device behavior quickly.
  const testTag = "[motion: style=normal speed=55 depth=middle duration=3s]";
  try {
    await postJson("/motion", { text: testTag });
    setStatus("Test motion sent");
  } catch (error) {
    setStatus(`Test error: ${error.message}`);
  }
}

function renderSettingsPanel() {
  const container = document.querySelector("#extensions_settings");
  if (!container || document.querySelector(`#${EXTENSION_NAME}-panel`)) return;

  const panel = document.createElement("div");
  panel.id = `${EXTENSION_NAME}-panel`;
  panel.className = "tavernplug-panel";
  panel.innerHTML = `
    <h4>TavernPlug Handy Bridge</h4>
    <div class="tavernplug-row">
      <label>Bridge URL</label>
      <input type="text" name="bridgeUrl" value="${settings.bridgeUrl}" />
    </div>
    <div class="tavernplug-row">
      <label>Handy Connection Key</label>
      <input type="text" name="handyConnectionKey" value="${settings.handyConnectionKey}" />
    </div>
    <div class="tavernplug-row">
      <label>Stroke Range (0-1)</label>
      <input type="number" step="0.01" min="0" max="1" name="strokeRange" value="${settings.strokeRange}" />
    </div>
    <div class="tavernplug-row">
      <label>Minimum Allowed Stroke (0-1)</label>
      <input type="number" step="0.01" min="0" max="1" name="minimumAllowedStroke" value="${settings.minimumAllowedStroke}" />
    </div>
    <div class="tavernplug-row">
      <label>Speed Range Min (0-1)</label>
      <input type="number" step="0.01" min="0" max="1" name="speedMin" value="${settings.speedMin}" />
    </div>
    <div class="tavernplug-row">
      <label>Speed Range Max (0-1)</label>
      <input type="number" step="0.01" min="0" max="1" name="speedMax" value="${settings.speedMax}" />
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
    </div>
    <div class="tavernplug-actions">
      <button class="menu_button" type="button" id="${EXTENSION_NAME}-test">Test Motion</button>
      <button class="menu_button tavernplug-stop" type="button" id="${EXTENSION_NAME}-stop">Emergency Stop</button>
    </div>
    <div class="tavernplug-status" id="${EXTENSION_NAME}-status">Idle</div>
  `;

  panel.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", onInputChange);
  });
  panel.querySelector(`#${EXTENSION_NAME}-test`)?.addEventListener("click", () => {
    void handleTestMotion();
  });
  panel.querySelector(`#${EXTENSION_NAME}-stop`)?.addEventListener("click", () => {
    void handleEmergencyStop();
  });

  container.append(panel);
  statusEl = panel.querySelector(`#${EXTENSION_NAME}-status`);
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    const message = getAssistantMessageFromContext();
    void sendMotionIfNeeded(message);
  }, 800);
}

function init() {
  renderSettingsPanel();
  startPolling();
  void syncConfig();
}

jQuery(() => {
  init();
});
