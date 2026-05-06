export const MODE_STYLES = ["tease", "gentle", "steady", "brisk", "hard", "intense"];
export const MODE_STYLE_ALIASES = {
  normal: "steady",
  rough: "hard"
};
export const MODE_STYLE_INPUTS = [
  ...MODE_STYLES,
  ...Object.keys(MODE_STYLE_ALIASES)
];
export const MODE_DEPTHS = ["tip", "shallow", "middle", "full", "deep"];
export const MODE_PATTERN_NAMES = [
  "wave",
  "pulse",
  "ramp",
  "random",
  "tease_hold",
  "edging_ramp",
  "edger",
  "doubletap",
  "pendulum",
  "tremor",
  "pulse_bursts",
  "depth_ladder",
  "stutter_break",
  "climax_window"
];
export const PATTERN_NAME_ALIASES = {
  tease: "tease_hold",
  teasehold: "tease_hold",
  teasing: "tease_hold",
  edging: "edging_ramp",
  edge: "edging_ramp",
  edger: "edger",
  double: "doubletap",
  doubletap: "doubletap",
  pendulum: "pendulum",
  swing: "pendulum",
  tremor: "tremor",
  flutter: "tremor",
  burst: "pulse_bursts",
  bursts: "pulse_bursts",
  ladder: "depth_ladder",
  stutter: "stutter_break",
  climax: "climax_window"
};
export const PATTERN_BUTTONS = [
  { buttonSuffix: "wave", pattern: "wave", label: "Wave" },
  { buttonSuffix: "pulse", pattern: "pulse", label: "Pulse" },
  { buttonSuffix: "ramp", pattern: "ramp", label: "Ramp" },
  { buttonSuffix: "random", pattern: "random", label: "Random" },
  { buttonSuffix: "tease", pattern: "tease_hold", label: "Tease" },
  { buttonSuffix: "edging", pattern: "edging_ramp", label: "Edging" },
  { buttonSuffix: "edger", pattern: "edger", label: "Edger" },
  { buttonSuffix: "doubletap", pattern: "doubletap", label: "Doubletap" },
  { buttonSuffix: "pendulum", pattern: "pendulum", label: "Pendulum" },
  { buttonSuffix: "tremor", pattern: "tremor", label: "Tremor" },
  { buttonSuffix: "burst", pattern: "pulse_bursts", label: "Burst" },
  { buttonSuffix: "ladder", pattern: "depth_ladder", label: "Ladder" },
  { buttonSuffix: "stutter", pattern: "stutter_break", label: "Stutter" },
  { buttonSuffix: "climax", pattern: "climax_window", label: "Climax" }
];

export const PATTERN_DEFINITIONS = {
  wave: {
    cycleMsMultiplier: 1.5,
    frames: [
      { style: "gentle", depth: "shallow" },
      { style: "steady", depth: "middle" },
      { style: "brisk", depth: "middle" },
      { style: "hard", depth: "full" },
      { style: "intense", depth: "deep" },
      { style: "hard", depth: "full" },
      { style: "brisk", depth: "middle" },
      { style: "steady", depth: "shallow" }
    ]
  },
  pulse: {
    frames: [
      { style: "steady", depth: "middle" },
      { style: "steady", depth: "middle" },
      { style: "hard", depth: "full" },
      { style: "gentle", depth: "deep", speedPct: 20 }
    ]
  },
  ramp: {
    cycleMsMultiplier: 1.35,
    frames: [
      { style: "tease", depth: "shallow" },
      { style: "gentle", depth: "middle" },
      { style: "steady", depth: "middle" },
      { style: "brisk", depth: "full" },
      { style: "hard", depth: "deep" },
      { style: "intense", depth: "deep" }
    ]
  },
  random: {
    randomized: true,
    randomStyles: ["steady", "brisk", "hard"],
    randomDepths: ["shallow", "middle", "full", "deep"]
  },
  tease_hold: {
    frames: [
      { style: "tease", depth: "tip", slideMinPct: 88, slideMaxPct: 97, durationMultiplier: 0.7 },
      { style: "gentle", depth: "shallow", slideMinPct: 74, slideMaxPct: 89, durationMultiplier: 0.95 },
      { style: "steady", depth: "middle", slideMinPct: 50, slideMaxPct: 72, durationMultiplier: 0.75 },
      { style: "tease", depth: "tip", slideMinPct: 90, slideMaxPct: 98, durationMultiplier: 0.55 },
      { style: "gentle", depth: "shallow", slideMinPct: 68, slideMaxPct: 85, durationMultiplier: 0.9 },
      { style: "brisk", depth: "middle", slideMinPct: 42, slideMaxPct: 66, durationMultiplier: 0.6 }
    ]
  },
  edging_ramp: {
    frames: [
      { style: "tease", depth: "shallow" },
      { style: "gentle", depth: "middle" },
      { style: "steady", depth: "full" },
      { style: "brisk", depth: "full" },
      { style: "hard", depth: "deep" },
      { style: "gentle", depth: "middle" }
    ]
  },
  edger: {
    frames: [
      { style: "gentle", depth: "shallow" },
      { style: "steady", depth: "middle" },
      { style: "brisk", depth: "full" },
      { style: "hard", depth: "full" },
      { style: "gentle", depth: "shallow" },
      { style: "tease", depth: "tip", slideMinPct: 90, slideMaxPct: 96 }
    ]
  },
  doubletap: {
    cycleMsMultiplier: 0.9,
    frames: [
      { style: "steady", depth: "middle" },
      { style: "hard", depth: "full", durationMultiplier: 0.6 },
      { style: "hard", depth: "deep", durationMultiplier: 0.6 },
      { style: "gentle", depth: "middle" },
      { style: "steady", depth: "middle" },
      { style: "hard", depth: "deep", durationMultiplier: 0.6 },
      { style: "gentle", depth: "shallow" }
    ]
  },
  pendulum: {
    cycleMsMultiplier: 1.4,
    frames: [
      { style: "gentle", depth: "shallow" },
      { style: "steady", depth: "middle" },
      { style: "brisk", depth: "full" },
      { style: "steady", depth: "middle" },
      { style: "gentle", depth: "shallow" }
    ]
  },
  tremor: {
    cycleMsMultiplier: 0.8,
    frames: [
      { style: "tease", depth: "tip", slideMinPct: 90, slideMaxPct: 96 },
      { style: "brisk", depth: "shallow", slideMinPct: 78, slideMaxPct: 88, durationMultiplier: 0.75 },
      { style: "tease", depth: "tip", slideMinPct: 90, slideMaxPct: 96 },
      { style: "hard", depth: "shallow", slideMinPct: 78, slideMaxPct: 88, durationMultiplier: 0.75 },
      { style: "gentle", depth: "shallow", slideMinPct: 78, slideMaxPct: 88 },
      { style: "tease", depth: "tip", slideMinPct: 90, slideMaxPct: 96 }
    ]
  },
  pulse_bursts: {
    frames: [
      { style: "hard", depth: "full", slideMinPct: 12, slideMaxPct: 46, durationMultiplier: 0.55 },
      { style: "intense", depth: "deep", slideMinPct: 0, slideMaxPct: 24, durationMultiplier: 0.45 },
      { style: "gentle", depth: "middle", slideMinPct: 38, slideMaxPct: 64, durationMultiplier: 0.8 },
      { style: "steady", depth: "shallow", slideMinPct: 64, slideMaxPct: 84, durationMultiplier: 0.7 }
    ]
  },
  depth_ladder: {
    frames: [
      { style: "steady", depth: "deep", slideMinPct: 0, slideMaxPct: 22 },
      { style: "steady", depth: "full", slideMinPct: 22, slideMaxPct: 42 },
      { style: "brisk", depth: "middle", slideMinPct: 42, slideMaxPct: 58 },
      { style: "hard", depth: "shallow", slideMinPct: 58, slideMaxPct: 74 },
      { style: "steady", depth: "tip", slideMinPct: 74, slideMaxPct: 90 }
    ]
  },
  stutter_break: {
    stepSpans: [3, 2, 1, 1, 1],
    frames: [
      { style: "hard", depth: "full" },
      { style: "hard", depth: "deep", slideMinPct: 0, slideMaxPct: 16 },
      { style: "hard", depth: "deep" },
      { style: "hard", depth: "deep", slideMinPct: 0, slideMaxPct: 16 },
      { style: "gentle", depth: "middle", durationMultiplier: 0.5 }
    ]
  },
  climax_window: {
    frames: [
      { style: "hard", depth: "full", slideMinPct: 14, slideMaxPct: 72 },
      { style: "intense", depth: "deep", slideMinPct: 0, slideMaxPct: 44 },
      { style: "hard", depth: "deep", slideMinPct: 6, slideMaxPct: 38 },
      { style: "brisk", depth: "full", slideMinPct: 20, slideMaxPct: 78 }
    ]
  }
};

export function normalizeCatalogStyleName(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return MODE_STYLE_ALIASES[value] ?? value;
}

export function normalizeCatalogDepthName(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

export function normalizeCatalogPatternName(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return PATTERN_NAME_ALIASES[value] ?? value;
}

export function getPatternDefinition(name) {
  return PATTERN_DEFINITIONS[normalizeCatalogPatternName(name)] ?? null;
}

export function getPatternFrame(name, step = 0) {
  const definition = getPatternDefinition(name);
  if (!definition) {
    return { style: "steady", depth: "middle" };
  }
  if (definition.randomized) {
    const styles = Array.isArray(definition.randomStyles) && definition.randomStyles.length
      ? definition.randomStyles
      : ["steady", "brisk", "hard"];
    const depths = Array.isArray(definition.randomDepths) && definition.randomDepths.length
      ? definition.randomDepths
      : ["shallow", "middle", "full", "deep"];
    return {
      style: styles[Math.floor(Math.random() * styles.length)],
      depth: depths[Math.floor(Math.random() * depths.length)]
    };
  }
  const frames = Array.isArray(definition.frames) ? definition.frames : [];
  if (!frames.length) {
    return { style: "steady", depth: "middle" };
  }
  return frames[((Math.trunc(step) % frames.length) + frames.length) % frames.length];
}

export function getPatternCycleSteps(name) {
  const definition = getPatternDefinition(name);
  const frames = Array.isArray(definition?.frames) ? definition.frames : [];
  return frames.length || 1;
}

export function getPatternCycleTargetMs(name, baseCycleMs) {
  const definition = getPatternDefinition(name);
  const multiplier = Number(definition?.cycleMsMultiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return Math.round(baseCycleMs);
  return Math.round(baseCycleMs * multiplier);
}

export function getPatternStepSpan(name, step = 0) {
  const definition = getPatternDefinition(name);
  const spans = Array.isArray(definition?.stepSpans) ? definition.stepSpans : null;
  if (!spans || !spans.length) return 1;
  const raw = Number(spans[((Math.trunc(step) % spans.length) + spans.length) % spans.length]);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.round(raw));
}

export function buildModeCatalogSnapshot() {
  return {
    styles: MODE_STYLES,
    styleInputs: MODE_STYLE_INPUTS,
    styleAliases: MODE_STYLE_ALIASES,
    depths: MODE_DEPTHS,
    patternNames: MODE_PATTERN_NAMES,
    patternAliases: PATTERN_NAME_ALIASES,
    patternButtons: PATTERN_BUTTONS,
    patterns: PATTERN_DEFINITIONS
  };
}
