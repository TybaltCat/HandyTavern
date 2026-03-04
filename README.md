# TavernPlug (HandyTavern)

TavernPlug converts SillyTavern text output to motion input for your Handy device.

## 30-Second Checklist (Skim This First)

1. Install Node.js + Git.
2. Clone this repo to a folder like `C:\TavernPlug`.
3. Run `.\launch-windows.ps1`.
4. Keep the bridge window open (`npm start` window must stay open and running).
5. In SillyTavern, open HandyTavern extension:
   - Input Handy connection key
   - Bridge URL = `http://127.0.0.1:8787`
   - click `Connect Device`
   - click `Check Bridge`
6. If setup says `Ready`, you are done.

If it says offline, the bridge is not running.

This project requires **2 parts**:

1. A SillyTavern extension (UI panel in SillyTavern)
2. A local bridge app (runs on your computer with `npm start`)

Important:

- Installing the extension by Git URL in SillyTavern is **not enough by itself**.
- You must also run the local bridge app.

## Before You Start

You need:

- A working SillyTavern install
- Node.js 18+ installed
- Git installed

Check in PowerShell:

```powershell
node --version
npm --version
git --version
```

If any command fails, install that tool first.

## Fastest Setup For Windows (Recommended)

These steps are written for non-technical users.

1. Pick a folder for TavernPlug.
Do not put it inside your SillyTavern folder.
Example:

`C:\TavernPlug`

2. Open PowerShell and download TavernPlug:

```powershell
git clone https://github.com/TybaltCat/HandyTavern C:\TavernPlug
cd C:\TavernPlug
```

3. Run the one-click launcher:

```powershell
.\launch-windows.ps1
```

What this script does:

- installs necessary dependencies
- creates `.env` if missing
- asks where your SillyTavern folder is
- copies necessary extension files into SillyTavern
- starts the bridge in a new PowerShell window

4. Keep the new bridge window open.
If you close it, the extension will go offline.

5. In SillyTavern:

- refresh the page
- open Extensions settings
- open HandyTavern panel
- paste your Handy Connection Key
- confirm Bridge URL is `http://127.0.0.1:8787`
- click `Connect Device`
- click `Check Bridge`

6. You are done when setup says `Ready`.

## Manual Setup (If You Do Not Want The Launcher)

1. Clone repo:

```powershell
git clone https://github.com/TybaltCat/HandyTavern C:\TavernPlug
cd C:\TavernPlug
```

2. Install dependencies:

```powershell
.\install.ps1
```

3. Copy these files from `C:\TavernPlug`:

- `manifest.json`
- `index.js`
- `style.css`

to this folder:

`<SillyTavern>\public\scripts\extensions\third-party\HandyTavern`

4. Start bridge:

```powershell
cd C:\TavernPlug
npm start
```

5. In SillyTavern, do the same connect steps as above.

## macOS / Linux

1. Clone repo
2. Run:

```bash
chmod +x ./install.sh
./install.sh
npm start
```

3. Copy `manifest.json`, `index.js`, and `style.css` into your SillyTavern third-party extension folder.
4. Refresh SillyTavern and connect from the extension panel.

## Handy Connection Key: Where To Set It

Recommended:

- Set key in extension UI (HandyTavern panel)

Optional:

- Set `HANDY_CONNECTION_KEY` in `.env` as a startup default

How it behaves:

- bridge reads `.env` on startup
- extension can update key via `/config`
- latest runtime config is persisted to `tavernplug.config.json`

## Advanced Settings Explained (Plain English)

These are the settings most people ask about once basic setup is working.

### Global Stroke Window

- This is your main allowed stroke zone (minimum to maximum).
- Example: `20% to 75%` means all motion is constrained to that part of travel.
- Pattern-specific slide windows are mapped **inside** this global window.

### Global Speed Window

- This sets your allowed speed range for all motions.
- Even if a prompt asks for high speed, speed is remapped into this window.

### Safe Mode

- Keeps motion from getting too aggressive.
- Caps speed and applies safety limits.
- Recommended to keep ON unless you know exactly why you need it OFF.

### Hold Motion Until Next Command

- ON: current motion keeps running until a new command arrives.
- OFF: motion can stop naturally after its duration.

### Stop Previous Motion When New Message Is Sent

- ON: new motion cuts over cleanly (less overlap, more predictable).
- OFF: transitions may blend more but can feel less consistent.

### Pattern Cycle Length (ms)

- Controls how long one full pattern loop takes.
- Higher value = slower, more spread-out pattern.
- Lower value = faster pattern loop.

### Pattern Notes

- `wave` and `ramp` are intentionally stretched longer than base cycle for smoother progression.
- Pattern step timing has slight jitter to avoid robotic perfect timing.

### Strict Tags

- ON: extension only acts on valid `[motion: ...]` tags.
- OFF: extension may infer motion from plain prose.
- If you want predictable behavior, keep this ON.

### Park at 0

- Sends a park/hold action to base position.
- This works even if the extension is currently paused.

## Prompt / System Prompt Setup (Important)

If you want consistent motion behavior, you should add a system/prompt rule so the LLM always outputs motion tags.

Where to put this in SillyTavern:

1. In the top-left area of SillyTavern, open **AI Response Configuration**.
2. Open your active prompt setup (the one used for your current chat/model).
3. Find the section for **System Prompt** (or equivalent global instruction field).
4. Paste the motion instruction block below.
5. Save/apply changes.
6. Generate a new reply and confirm the final line includes a `[motion: ...]` tag.

If your setup uses Author's Note or Prompt Injections, you can also place the rule there, but System Prompt is usually the most reliable place.

Use this block in your system prompt (or equivalent instruction area):

```text
When physical sexual motion is present, end the reply with exactly one motion tag on its own line.

Direct motion format:
[motion: style=<gentle|brisk|normal|hard|intense> speed=<0-100> depth=<tip|middle|full|deep> duration=<Ns>]

Pattern format:
[motion: pattern=<wave|pulse|ramp|random|tease_hold|edging_ramp|pulse_bursts|depth_ladder|stutter_break|climax_window> speed=<0-100> interval=<Ns> duration=<Ns>]

Stop pattern:
[motion: pattern=stop]

Rules:
- Output exactly one motion tag per reply when physical motion is present.
- Put the tag on the final line.
- Do not output extra tag fields.
```

Practical recommendation:

- Keep `Strict Tags` ON in extension settings.
- Use prompt instructions like above so the model reliably emits tags.

## If Something Is Not Working

### "Bridge offline"

- make sure `npm start` is running in TavernPlug folder
- make sure powershell window is still open and running
- make sure Bridge URL is `http://127.0.0.1:8787`
- click `Check Bridge`

### "I installed extension but UI did not change"

- you probably updated repo files but did not copy them into SillyTavern extension folder
- re-copy `index.js` and `style.css`
- refresh SillyTavern

### "Not connecting to device"

- verify Handy key is correct in extension UI
- if you changed `.env`, restart bridge
- click `Connect Device` again

### "Worked before, now dead"

- bridge terminal likely closed
- run `npm start` in powershell window in TavernPlug folder

## Updating TavernPlug

From your TavernPlug folder:

```powershell
git pull
npm install
```

Then copy latest extension files (`manifest.json`, `index.js`, `style.css`) to SillyTavern extension folder again, and restart bridge.

## Script Reference

### `launch-windows.ps1`

One-click setup + copy + launch.

Optional flags:

- `-SillyTavernPath "C:\Path\To\SillyTavern"`
- `-NoLaunch` (skip auto-starting bridge)
- `-ForceEnv` (overwrite `.env` from template)

### `install.ps1`

Install dependencies and create `.env` (if missing). Does not copy extension files automatically.

## Motion Tag Format (For Prompting)

Recommended format:

`[motion: style=normal speed=60 depth=middle duration=6s]`

Valid values:

- `style`: `gentle|brisk|normal|hard|intense|rough`
- `speed`: `0-100` (or `0.0-1.0`)
- `depth`: `tip|middle|full|deep`
- `duration`: seconds or ms (`6s`, `800ms`)

Pattern tags are also supported:

`[motion: pattern=wave speed=55 interval=1.8s duration=20s]`

Stop pattern:

`[motion: pattern=stop]`

## Security Note

Keep the bridge local (`127.0.0.1`) unless you know exactly how to secure remote access.
