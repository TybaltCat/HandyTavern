# TavernPlug

Parses text (from SillyTavern or any local source) into motion intent and sends commands to a Buttplug-compatible device, including Handy V2 through an Intiface/Buttplug server.

## What this does

- Accepts text on `POST /motion` (`{ "text": "..." }`).
- Extracts:
  - `style` (`gentle`, `normal`, `rough`)
  - `depth` (`tip`, `middle`, `full`, `deep`)
  - `speed` (0.0 to 1.0)
  - `durationMs`
- Sends command to the first device whose name contains `DEVICE_NAME_FILTER` (default `handy`).

## Quick start

1. Install dependencies:
   - `npm install`
2. Create env:
   - `Copy-Item .env.example .env`
3. Start API in simulation mode:
   - `npm start`
4. Test parsing:
   - `Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/motion -ContentType 'application/json' -Body '{"text":"[motion: style=rough speed=80 depth=deep duration=8s]"}'`

You should get a JSON response with parsed motion.

## Device mode

1. Start your local Buttplug server (for example Intiface Desktop).
2. Pair your Handy V2 in that server.
3. Set in `.env`:
   - `ENABLE_DEVICE=true`
4. Restart this service.

## SillyTavern integration idea

This repo now includes extension files at the repository root:

- `manifest.json`
- `index.js`
- `style.css`

Install by copying those files into a single folder in your SillyTavern third-party extensions directory, for example:

- `<SillyTavern>/public/scripts/extensions/third-party/tavernplug-handy`

Then reload SillyTavern and open Extensions settings.

The extension UI lets you set:

- Handy Connection Key
- Stroke Range
- Speed Range Min/Max
- Minimum Allowed Stroke
- Stop previous motion when a new message is sent
- Safe Mode toggle + caps (max speed/duration)
- Bridge URL
- Test Motion button
- Emergency Stop button

The extension sends assistant messages to:

- `http://127.0.0.1:8787/motion`

Recommended prompt convention for better parsing:

- `[motion: style=rough speed=75 depth=full duration=6s]`

Strict mode is enabled by default (`STRICT_MOTION_TAG=true`). The motion tag is required and fields are:

- `style`: `gentle|normal|rough` (default `normal`)
- `speed`: `0-100` or `0.0-1.0` (required)
- `depth`: `tip|middle|full|deep` (default `middle`)
- `duration`: `ms` or `s` suffix, e.g. `800ms`, `6s` (default `5s`)

## Bridge API endpoints

- `POST /motion` with `{ "text": "[motion: ...]" }`
- `POST /config` with:
  - `handyConnectionKey` (string)
  - `strokeRange` (0..1)
  - `speedMin` (0..1)
  - `speedMax` (0..1)
  - `minimumAllowedStroke` (0..1)
  - `safeMode` (boolean)
  - `safeMaxSpeed` (0..1)
  - `safeMaxDurationMs` (integer, ms)
  - `stopPreviousOnNewMotion` (boolean)
- `POST /emergency-stop` to force stop

## Notes

- This implementation sends scalar/vibrate style intensity. If your Handy setup expects linear stroke commands, you can expand `src/handyController.js` with `linear` command mapping.
- `handyConnectionKey` is accepted and stored by the bridge so the extension can manage it in one place; direct Handy cloud authentication is not used by Buttplug mode.
- Keep this strictly local (`127.0.0.1`) unless you add authentication and transport security.
