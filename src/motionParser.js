// Add/remove allowed style words for strict [motion: ...] tags here.
const VALID_STYLES = new Set(["gentle", "normal", "rough"]);
// Add/remove allowed depth words for strict tags here.
const VALID_DEPTHS = new Set(["tip", "middle", "full", "deep"]);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function parseSpeed(raw) {
  const cleaned = String(raw).trim().replace(/%$/, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid speed value "${raw}"`);
  }

  if (parsed > 1) return clamp01(parsed / 100);
  if (parsed < 0) throw new Error("Speed must be >= 0");
  return clamp01(parsed);
}

function parseDurationMs(raw) {
  // Extend this regex if you want to accept extra units (for example "m" for minutes).
  const cleaned = String(raw).trim().toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds)?$/);
  if (!match) {
    throw new Error(`Invalid duration value "${raw}"`);
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Duration must be a positive number");
  }

  const unit = match[2] ?? "s";
  if (unit === "ms") return Math.round(value);
  return Math.round(value * 1000);
}

function parseTagBody(tagBody) {
  const fields = {};
  // Key=value tokenizer for [motion: ...]. Update if you want quoted values.
  const pattern = /([a-z]+)\s*=\s*([^\s\]]+)/gi;
  let match = pattern.exec(tagBody);
  while (match) {
    fields[match[1].toLowerCase()] = match[2];
    match = pattern.exec(tagBody);
  }
  return fields;
}

function parseTaggedMotion(text) {
  // Strict tag format enforcement. Change this regex if you want a different wrapper.
  const tagMatch = text.match(/\[motion:\s*([^\]]+)\]/i);
  if (!tagMatch) {
    throw new Error(
      'Missing motion tag. Use format: [motion: style=normal speed=60 depth=middle duration=6s]'
    );
  }

  const fields = parseTagBody(tagMatch[1]);
  const style = (fields.style ?? "normal").toLowerCase();
  const depth = (fields.depth ?? "middle").toLowerCase();

  if (!VALID_STYLES.has(style)) {
    throw new Error('Invalid style. Allowed: gentle, normal, rough');
  }

  if (!VALID_DEPTHS.has(depth)) {
    throw new Error('Invalid depth. Allowed: tip, middle, full, deep');
  }

  if (!fields.speed) {
    throw new Error("Missing speed in motion tag");
  }

  return {
    style,
    depth,
    speed: parseSpeed(fields.speed),
    durationMs: parseDurationMs(fields.duration ?? "5s")
  };
}

function parseRelaxedMotion(text) {
  const lower = text.toLowerCase();
  // Add alternative free-text style words in this regex when strict mode is disabled.
  const style = VALID_STYLES.has(lower.match(/\b(gentle|normal|rough)\b/)?.[1] ?? "")
    ? lower.match(/\b(gentle|normal|rough)\b/)[1]
    : "normal";
  // Add alternative free-text depth words here when strict mode is disabled.
  const depth = VALID_DEPTHS.has(lower.match(/\b(tip|middle|full|deep)\b/)?.[1] ?? "")
    ? lower.match(/\b(tip|middle|full|deep)\b/)[1]
    : "middle";

  // Extend speed patterns (e.g. bpm/hz aliases) here for relaxed parsing.
  const speedMatch = text.match(/\bspeed\s*[:=]?\s*(\d+(?:\.\d+)?%?)\b/i)
    ?? text.match(/\b(\d{1,3})\s*%/i);
  const durationMatch = text.match(
    /\bfor\s+(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds)\b/i
  );

  return {
    style,
    depth,
    speed: parseSpeed(speedMatch?.[1] ?? "50"),
    durationMs: parseDurationMs(
      durationMatch ? `${durationMatch[1]}${durationMatch[2]}` : "5s"
    )
  };
}

export function parseMotion(text, options = {}) {
  const strictTag = options.strictTag ?? true;
  if (strictTag) return parseTaggedMotion(text);

  return parseRelaxedMotion(text);
}
