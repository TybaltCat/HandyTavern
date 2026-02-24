// Add/remove allowed style words for strict [motion: ...] tags here.
const VALID_STYLES = new Set(["gentle", "brisk", "normal", "hard", "intense", "rough"]);
// Add/remove allowed depth words for strict tags here.
const VALID_DEPTHS = new Set(["tip", "middle", "full", "deep"]);
// Add/remove supported pattern names for temporary LLM pattern triggers here.
const VALID_PATTERNS = new Set([
  "wave",
  "pulse",
  "ramp",
  "random",
  "tease_hold",
  "edging_ramp",
  "pulse_bursts",
  "depth_ladder",
  "stutter_break",
  "climax_window"
]);
const PATTERN_NAME_ALIASES = {
  tease: "tease_hold",
  teasehold: "tease_hold",
  teasing: "tease_hold",
  edging: "edging_ramp",
  edge: "edging_ramp",
  burst: "pulse_bursts",
  bursts: "pulse_bursts",
  ladder: "depth_ladder",
  stutter: "stutter_break",
  climax: "climax_window"
};
const PATTERN_STOP_WORDS = new Set(["off", "stop", "none"]);

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

function parsePatternName(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  const aliased = PATTERN_NAME_ALIASES[value] ?? value;
  if (!VALID_PATTERNS.has(aliased)) {
    throw new Error("Invalid pattern. Allowed: wave, pulse, ramp, random, tease_hold, edging_ramp, pulse_bursts, depth_ladder, stutter_break, climax_window");
  }
  return aliased;
}

function isPatternStopWord(raw) {
  return PATTERN_STOP_WORDS.has(String(raw ?? "").trim().toLowerCase());
}

function scoreByKeywords(text, dictionary) {
  const lower = String(text ?? "").toLowerCase();
  const scores = {};
  for (const key of Object.keys(dictionary)) {
    scores[key] = 0;
    for (const entry of dictionary[key]) {
      const match = lower.match(entry.pattern);
      if (!match) continue;
      scores[key] += entry.weight;
    }
  }
  return scores;
}

const LIGHT_INTENSITY_WORDS = [
  "tease", "caress", "stroke", "glide", "rub",
  "soft", "slow", "gentle", "easy", "lazy",
  "fondle", "massage", "kiss", "lick", "suckle",
  "nuzzle", "trace", "grind lightly", "rock slowly",
  "stroke gently", "explore", "touch", "brush against"
];

const MEDIUM_INTENSITY_WORDS = [
  "thrust", "pump", "slide", "rock", "grind",
  "steady", "rhythm", "pace", "deep", "firm",
  "suck", "fuck", "ride", "stroke firmly", "hump",
  "slide in", "penetrate", "go down on", "eat out",
  "finger", "tongue", "lap at"
];

const HIGH_INTENSITY_WORDS = [
  "pound", "ram", "jackhammer", "drive", "plow",
  "fast", "hard", "rough", "frantic", "desperate",
  "deep throat", "face fuck", "drill", "ram into",
  "slam against", "ravage", "dominate", "breed",
  "make cum", "force orgasm", "overstimulate",
  "claim", "destroy"
];

const CONTEXT_MODERATE_BOOST_WORDS = [
  "against the wall", "on the floor", "over the desk",
  "from behind", "bent over", "legs spread"
];

const CONTEXT_STRONG_BOOST_WORDS = [
  "until you scream", "until i say stop"
];

function countKeywordHits(text, words) {
  const lower = String(text ?? "").toLowerCase();
  let hits = 0;
  for (const word of words) {
    const regex = new RegExp(`\\b${word}\\b`, "i");
    if (regex.test(lower)) hits += 1;
  }
  return hits;
}

function detectIntensityTier(text) {
  const lightHits = countKeywordHits(text, LIGHT_INTENSITY_WORDS);
  const mediumHits = countKeywordHits(text, MEDIUM_INTENSITY_WORDS);
  const highHits = countKeywordHits(text, HIGH_INTENSITY_WORDS);

  if (highHits >= Math.max(lightHits, mediumHits, 1)) return "high";
  if (mediumHits >= Math.max(lightHits, 1)) return "medium";
  if (lightHits >= 1) return "light";
  return "none";
}

function detectContextBoost(text) {
  const moderate = countKeywordHits(text, CONTEXT_MODERATE_BOOST_WORDS);
  const strong = countKeywordHits(text, CONTEXT_STRONG_BOOST_WORDS);
  return {
    moderate,
    strong,
    total: moderate + strong * 2
  };
}

function hashText(input) {
  const value = String(input ?? "");
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deterministicChance(text, salt, threshold) {
  const h = hashText(`${String(text ?? "")}|${salt}`);
  const normalized = (h % 1000) / 1000;
  return normalized < threshold;
}

function shouldAutoTriggerPattern(text, inferredPattern) {
  if (!inferredPattern) return false;
  // Keep auto-pattern activation intentionally rare.
  // Explicit pattern commands still always trigger.
  const probability = 0.15;
  return deterministicChance(text, `auto-pattern-${inferredPattern}`, probability);
}

function maybePickMotifByTier(text) {
  const tier = detectIntensityTier(text);
  const lower = String(text ?? "").toLowerCase();

  if (tier === "light") {
    if (/\b(tease|caress|fondle|massage|brush against|nuzzle|kiss)\b/i.test(lower)) {
      return deterministicChance(text, "tease_hold", 0.45) ? "tease_hold" : null;
    }
    return null;
  }

  if (tier === "medium") {
    if (/\b(build|edge|edging|escalate|pace)\b/i.test(lower)) {
      return deterministicChance(text, "edging_ramp", 0.55) ? "edging_ramp" : null;
    }
    if (/\b(thrust|pump|rock|grind|rhythm)\b/i.test(lower)) {
      return deterministicChance(text, "depth_ladder", 0.3) ? "depth_ladder" : null;
    }
    return null;
  }

  if (tier === "high") {
    if (/\b(jackhammer|pound|ram|drill|slam)\b/i.test(lower)) {
      return deterministicChance(text, "pulse_bursts", 0.5) ? "pulse_bursts" : null;
    }
    if (/\b(overstimulate|desperate|frantic|force orgasm)\b/i.test(lower)) {
      return deterministicChance(text, "stutter_break", 0.45) ? "stutter_break" : null;
    }
    if (/\b(make cum|breed|claim|destroy)\b/i.test(lower)) {
      return deterministicChance(text, "climax_window", 0.35) ? "climax_window" : null;
    }
  }

  return null;
}

function pickHighestScore(scores, fallback, minScore = 1) {
  let bestKey = fallback;
  let bestScore = Number.MIN_SAFE_INTEGER;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestScore >= minScore ? bestKey : fallback;
}

function inferStyleFromScoring(text) {
  const tier = detectIntensityTier(text);
  const context = detectContextBoost(text);
  // Tune these weights/words to control style inference behavior in relaxed mode.
  const styleScores = scoreByKeywords(text, {
    gentle: [
      { pattern: /\b(gentle|tender|soft|sweet|warm|soothing|calm|careful|kind|nurturing|comforting|patient|hushed|mild|featherlight|plush|caress|cuddle|lull|cradle|murmur|hush|comfort|warmth|softness|balm|glow|lullaby|light)\b/i, weight: 2 }
    ],
    brisk: [
      { pattern: /\b(brisk|steady|firm)\b/i, weight: 2 },
      { pattern: /\b(quick|faster)\b/i, weight: 1 }
    ],
    normal: [
      { pattern: /\b(normal|steady|easy|casual|relaxed|regular|even|measured|natural|simple|plain|consistent|unremarkable|everyday|familiar|baseline|steadiness|routine|stride|pace|tempo|meter|beat|pattern)\b/i, weight: 2 },
      { pattern: /\b(slow)\b/i, weight: 1 }
    ],
    hard: [
      { pattern: /\b(hard|rough|strong|forceful|firm|driving|assertive|insistent|solid|pushing|bold|determined|relentless|pressing|intense|heavy|powerful|slam|surge|force)\b/i, weight: 2 },
      { pattern: /\b(fast|faster)\b/i, weight: 1 }
    ],
    intense: [
      { pattern: /\b(intense|extreme|wild|aggressive|fierce|ravenous|heated|urgent|hungry|breathless|fevered|frantic|electric|charged|explosive|scorching|ferocious|relentless|consuming)\b/i, weight: 2 },
      { pattern: /\b(max|maximum)\b/i, weight: 1 }
    ]
  });

  // Tier stacker from user-provided word groups.
  if (tier === "light") {
    styleScores.gentle += 4;
    styleScores.normal += 1;
  } else if (tier === "medium") {
    styleScores.brisk += 2;
    styleScores.normal += 3;
    styleScores.hard += 1;
  } else if (tier === "high") {
    styleScores.hard += 3;
    styleScores.intense += 4;
  }
  if (context.total > 0) {
    styleScores.hard += context.total;
    styleScores.intense += context.strong;
  }

  return pickHighestScore(styleScores, "normal");
}

function inferDepthFromScoring(text) {
  const tier = detectIntensityTier(text);
  const context = detectContextBoost(text);
  // Tune depth scoring words here for relaxed mode.
  const depthScores = scoreByKeywords(text, {
    tip: [
      { pattern: /\b(tip|shallow|edge|glans|frenulum|inch|crown|corona|slit|vulva|labia|outer lips)\b/i, weight: 2 }
    ],
    middle: [
      { pattern: /\b(middle|mid|medium|sheath|your length|measured|limited)\b/i, weight: 2 }
    ],
    full: [
      { pattern: /\b(full|deep-ish|deeper)\b/i, weight: 2 }
    ],
    deep: [
      { pattern: /\b(deep|deepest|bottom|all the way|throat|gasp|gasping|deep-throat|buried|plunge|choked|choking|diving|esophagus|hilt|cervix|deep penetration|invading|sinking|plunging|driving|reaching|searching|anchored|weighty|resonant|consuming|unyielding|rooted|far-reaching|dive|swallowed)\b/i, weight: 3 }
    ]
  });

  // Tier stacker to bias stroke depth.
  if (tier === "light") {
    depthScores.tip += 2;
    depthScores.middle += 2;
  } else if (tier === "medium") {
    depthScores.middle += 2;
    depthScores.full += 3;
  } else if (tier === "high") {
    depthScores.full += 2;
    depthScores.deep += 4;
  }
  if (context.total > 0) {
    depthScores.full += context.moderate;
    depthScores.deep += context.total;
  }

  return pickHighestScore(depthScores, "middle");
}

function inferPatternFromScoring(text) {
  const tier = detectIntensityTier(text);
  const context = detectContextBoost(text);
  // Tune pattern inference words here. Used as temporary auto-pattern trigger.
  const patternScores = scoreByKeywords(text, {
    wave: [
      { pattern: /\b(thrust|thrusts|stroking|stroke|back and forth|rocking)\b/i, weight: 2 },
      { pattern: /\b(sway|wave)\b/i, weight: 1 },
      // Smooth and rounded
      { pattern: /\b(fluid|flowing|gliding|rolling|wave-like|seamless|continuous|silky|velvety|buttery|supple|pliant|cushioned|rounded|eased|elastic|gentle-curved|soft-edged|undulating|drifting|molten|mellow|steadying|even-tempered)\b/i, weight: 2 },
      // Controlled and deliberate
      { pattern: /\b(deliberate|measured|precise|exact|intentional|purposeful|disciplined|steady-handed|regulated|controlled|contained|restrained|composed|grounded|centered|surgical|methodical|consistent|calculated|dialed-in)\b/i, weight: 1 }
    ],
    pulse: [
      { pattern: /\b(pulse|pulsing|burst|bursts|tease|teasing)\b/i, weight: 2 },
      // Pulsed and rhythmic
      { pattern: /\b(pulsed|throbbing|metered|rhythmic|cadenced|steady-beat|tempoed|patterned|looping|cyclical|swaying|rocking|loping|marching|drumming|heartbeat-like|pendulum|oscillating|ticking|churning|rolling-beat)\b/i, weight: 2 }
    ],
    ramp: [
      { pattern: /\b(ramp|build|building|escalate|climb)\b/i, weight: 2 },
      { pattern: /\b(faster and faster|speed up)\b/i, weight: 2 },
      { pattern: /\b(faster and deeper|deeper and faster)\b/i, weight: 3 },
      // Swell and release (builds)
      { pattern: /\b(surging|swelling|rising|ramping|cresting|blooming|gathering|mounting|intensifying|lifting|peaking|tapering|ebbing|fading|cascading|rolling-in|wave-building|pressure-building|crescendoing)\b/i, weight: 2 }
    ],
    random: [
      { pattern: /\b(random|chaotic|unpredictable|mixed)\b/i, weight: 2 },
      // Staccato and choppy
      { pattern: /\b(staccato|choppy|jagged|jerky|twitchy|stop-start|broken|fragmented|syncopated|skittery|jittery|rattling|shuddery|hiccuping|spasmodic|uneven|restless|rough-cut)\b/i, weight: 2 },
      // Messy and wild
      { pattern: /\b(wild|untamed|feral|unruly|frantic|feverish|breathless|reckless|unbridled|stormy|raging|torrential|uncontained|runaway|spiraling|exploding|volatile|rabid|savage)\b/i, weight: 2 },
      // Punchy and percussive
      { pattern: /\b(snappy|punchy|percussive|popping|cracking|hammering|hitting|striking|jabbing|driving|slamming|thudding|hard-edged|sharp|brisk-cut|clipped|emphatic|accented|spiky)\b/i, weight: 2 }
    ]
  });

  // Tier stacker to choose pattern feel.
  if (tier === "light") {
    patternScores.wave += 3;
    patternScores.pulse += 1;
  } else if (tier === "medium") {
    patternScores.wave += 2;
    patternScores.ramp += 2;
  } else if (tier === "high") {
    patternScores.ramp += 3;
    patternScores.pulse += 2;
    patternScores.random += 1;
  }
  if (context.total > 0) {
    patternScores.ramp += context.total;
  }

  // Thematic nudges for special motif variants.
  if (/\b(teasing|flirty|coy|mischievous|cheeky|playful|impish|sly|puckish|kittenish|bubbly|bouncy|lighthearted|sing-song|winking|taunting|baiting|ticklish|feathering|skimming)\b/i.test(text)) {
    patternScores.wave += 2;
  }
  if (/\b(snappy|punchy|percussive|popping|cracking|hammering|jabbing|slamming|thudding|clipped|spiky)\b/i.test(text)) {
    patternScores.pulse += 2;
  }

  const scored = pickHighestScore(patternScores, null, 2);
  const motif = maybePickMotifByTier(text);
  return motif ?? scored;
}

function hasFasterDeeperPhrase(text) {
  return /\b(faster and deeper|deeper and faster)\b/i.test(String(text ?? ""));
}

function computeAnatomicalBoost(text) {
  // Temporary "engagement boost" words. Tune or remove anytime.
  const lower = String(text ?? "").toLowerCase();
  const terms = [
    "shaft",
    "tip",
    "head",
    "glans",
    "cock",
    "dick",
    "penis",
    "balls",
    "prostate"
  ];
  let hits = 0;
  for (const term of terms) {
    const regex = new RegExp(`\\b${term}\\b`, "i");
    if (regex.test(lower)) hits += 1;
  }

  // +0.05 per detected term, capped at +0.20.
  return Math.min(0.2, hits * 0.05);
}

function parseIntervalMs(raw) {
  // Reuse duration parser so interval supports units like 1200ms or 1.5s.
  return parseDurationMs(raw);
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
    throw new Error("Invalid style. Allowed: gentle, brisk, normal, hard, intense, rough");
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
  const tier = detectIntensityTier(text);
  const context = detectContextBoost(text);
  // Add alternative free-text style words in this regex when strict mode is disabled.
  const explicitStyle = lower.match(/\b(gentle|brisk|normal|hard|intense|rough)\b/)?.[1] ?? "";
  const style = VALID_STYLES.has(explicitStyle) ? explicitStyle : inferStyleFromScoring(text);
  // Add alternative free-text depth words here when strict mode is disabled.
  const explicitDepth = lower.match(/\b(tip|middle|full|deep)\b/)?.[1] ?? "";
  let depth = VALID_DEPTHS.has(explicitDepth) ? explicitDepth : inferDepthFromScoring(text);

  // Extend speed patterns (e.g. bpm/hz aliases) here for relaxed parsing.
  const speedMatch = text.match(/\bspeed\s*[:=]?\s*(\d+(?:\.\d+)?%?)\b/i)
    ?? text.match(/\b(\d{1,3})\s*%/i);
  const durationMatch = text.match(
    /\bfor\s+(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds)\b/i
  );

  const hasExplicitSpeed = Boolean(speedMatch?.[1]);
  let speed = parseSpeed(speedMatch?.[1] ?? "50");

  // Apply tier-based speed bias when speed is inferred from language (no explicit numeric speed).
  if (!hasExplicitSpeed) {
    if (tier === "light") speed = clamp01(speed - 0.15);
    if (tier === "medium") speed = clamp01(speed + 0.05);
    if (tier === "high") speed = clamp01(speed + 0.2);
  }
  if (!hasExplicitSpeed && context.total > 0) {
    speed = clamp01(speed + Math.min(0.15, context.total * 0.05));
  }

  speed = clamp01(speed + computeAnatomicalBoost(text));

  if (hasFasterDeeperPhrase(text)) {
    speed = clamp01(speed + 0.1);
    if (!VALID_DEPTHS.has(explicitDepth)) {
      depth = "deep";
    }
  }

  return {
    style,
    depth,
    speed,
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

export function hasMotionIntent(text, options = {}) {
  const strictTag = options.strictTag ?? true;
  const source = String(text ?? "");
  if (!source.trim()) return false;

  if (strictTag) {
    return /\[motion:\s*[^\]]+\]/i.test(source);
  }

  const lower = source.toLowerCase();
  const hasExplicitStyle = /\b(gentle|brisk|normal|hard|intense|rough)\b/i.test(lower);
  const hasExplicitDepth = /\b(tip|middle|full|deep)\b/i.test(lower);
  const hasExplicitSpeed = /\bspeed\s*[:=]?\s*\d+(?:\.\d+)?%?\b/i.test(lower);
  const hasExplicitDuration = /\b(?:for|duration)\s*[:=]?\s*\d+(?:\.\d+)?(?:ms|s|sec|secs|second|seconds)\b/i.test(lower);
  const hasTierOrBoost =
    detectIntensityTier(source) !== "none"
    || detectContextBoost(source).total > 0
    || computeAnatomicalBoost(source) > 0
    || hasFasterDeeperPhrase(source);
  const hasPatternSignal = parseRelaxedPatternTrigger(source) !== null;

  return (
    hasExplicitStyle
    || hasExplicitDepth
    || hasExplicitSpeed
    || hasExplicitDuration
    || hasTierOrBoost
    || hasPatternSignal
  );
}

export function parsePatternTrigger(text, options = {}) {
  const strictTag = options.strictTag ?? true;

  if (strictTag) {
    const tagMatch = text.match(/\[motion:\s*([^\]]+)\]/i);
    if (!tagMatch) return null;

    const fields = parseTagBody(tagMatch[1]);
    const patternValue = fields.pattern ?? fields.mode;
    if (!patternValue) return null;
    if (isPatternStopWord(patternValue)) {
      return { stop: true };
    }

    return {
      auto: false,
      explicit: true,
      pattern: parsePatternName(patternValue),
      speed: fields.speed ? parseSpeed(fields.speed) : 0.55,
      intervalMs: fields.interval ? parseIntervalMs(fields.interval) : 1800,
      durationMs: fields.duration ? parseDurationMs(fields.duration) : 20000
    };
  }

  return parseRelaxedPatternTrigger(text);
}

function parseRelaxedPatternTrigger(text) {
  const lower = String(text ?? "").toLowerCase();
  if (/\b(?:pattern|mode)\s*[:=]?\s*(off|stop|none)\b/i.test(lower)) {
    return { stop: true };
  }
  const explicit = lower.match(
    /\b(?:pattern|mode)\s*[:=]?\s*(wave|pulse|ramp|random|tease_hold|edging_ramp|pulse_bursts|depth_ladder|stutter_break|climax_window|tease|edging|burst|ladder|stutter|climax)\b/i
  ) ?? lower.match(
    /\b(wave|pulse|ramp|random|tease|edging|burst|ladder|stutter|climax)\s+pattern\b/i
  );

  const intervalMatch = lower.match(/\binterval\s*[:=]?\s*(\d+(?:\.\d+)?(?:ms|s|sec|secs|second|seconds)?)\b/i);
  const durationMatch = lower.match(/\b(?:duration|for)\s*[:=]?\s*(\d+(?:\.\d+)?(?:ms|s|sec|secs|second|seconds)?)\b/i);
  const speedMatch = lower.match(/\bspeed\s*[:=]?\s*(\d+(?:\.\d+)?%?)\b/i);

  const inferred = inferPatternFromScoring(text);
  const pattern = explicit
    ? parsePatternName(explicit[1])
    : shouldAutoTriggerPattern(text, inferred) ? inferred : null;
  if (!pattern) return null;

  return {
    auto: !Boolean(explicit),
    explicit: Boolean(explicit),
    pattern,
    speed: speedMatch ? parseSpeed(speedMatch[1]) : 0.55,
    intervalMs: intervalMatch ? parseIntervalMs(intervalMatch[1]) : 1800,
    durationMs: durationMatch ? parseDurationMs(durationMatch[1]) : 20000
  };
}

export function getMotionDebug(text, options = {}) {
  const strictTag = options.strictTag ?? true;
  const source = String(text ?? "");

  if (strictTag) {
    const tagMatch = source.match(/\[motion:\s*([^\]]+)\]/i);
    if (!tagMatch) {
      return { mode: "strict", hasTag: false };
    }
    const fields = parseTagBody(tagMatch[1]);
    return {
      mode: "strict",
      hasTag: true,
      style: fields.style ?? null,
      depth: fields.depth ?? null,
      speed: fields.speed ?? null,
      pattern: fields.pattern ?? fields.mode ?? null
    };
  }

  return {
    mode: "relaxed",
    hasIntent: hasMotionIntent(source, { strictTag: false }),
    tier: detectIntensityTier(source),
    contextBoost: detectContextBoost(source).total,
    fasterDeeper: hasFasterDeeperPhrase(source),
    anatomicalBoost: computeAnatomicalBoost(source),
    inferredStyle: inferStyleFromScoring(source),
    inferredDepth: inferDepthFromScoring(source),
    inferredPattern: inferPatternFromScoring(source)
  };
}
