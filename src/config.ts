/**
 * pausecut configuration.
 *
 * All durations are in seconds unless the name says otherwise.
 */

export type GapAction = "keep" | "cut" | "squeeze" | "marker";
export type MotionLevel = "still" | "active" | "unknown";

export interface VadConfig {
  /** Speech probability above which a window is considered speech. */
  threshold: number;
  /** Speech ends only when probability drops below this (hysteresis). Defaults to threshold - 0.15. */
  negThreshold?: number;
  /** Speech bursts shorter than this are discarded (false positives from clicks, card shuffles). */
  minSpeech: number;
  /** Silence shorter than this inside speech is bridged (breath, consonant gaps). */
  minSilence: number;
  /** Padding added to both ends of every speech segment before gap analysis. */
  speechPad: number;
}

export interface TierConfig {
  /** Gaps in [cutMin, squeezeMin) are removed entirely (minus padding). */
  cutMin: number;
  /** Gaps in [squeezeMin, markerMin) are shortened to `squeezeTo`. */
  squeezeMin: number;
  /** Gaps >= markerMin are kept and marked for manual review. */
  markerMin: number;
  /** Target length a squeezed gap is reduced to. */
  squeezeTo: number;
  /** Silence kept after the end of speech on every cut. */
  padBefore: number;
  /** Silence kept before the start of speech on every cut. */
  padAfter: number;
}

export interface MotionConfig {
  /** Run frame-difference motion analysis on gaps (needs a video stream). */
  enabled: boolean;
  /** Mean absolute pixel difference (0-255 scale) below which a gap is "still". */
  stillThreshold: number;
  /** Analysis frame rate. */
  fps: number;
  /** Analysis frame width (height follows aspect). */
  width: number;
  /**
   * How motion changes the tier decision:
   *  - "promote": still gaps are cut more aggressively (squeeze→cut, marker→squeeze),
   *               active gaps are kept more conservatively (squeeze→keep).
   *  - "off": motion is recorded in the report but does not change decisions.
   */
  mode: "promote" | "off";
}

export interface PausecutConfig {
  vad: VadConfig;
  tiers: TierConfig;
  motion: MotionConfig;
  /** Only analyze this time range of the source (seconds). */
  range?: { start?: number; end?: number };
}

export const defaultConfig: PausecutConfig = {
  vad: {
    threshold: 0.5,
    minSpeech: 0.25,
    minSilence: 0.1,
    speechPad: 0.03,
  },
  tiers: {
    cutMin: 0.3,
    squeezeMin: 1.0,
    markerMin: 4.0,
    squeezeTo: 0.6,
    padBefore: 0.08,
    padAfter: 0.08,
  },
  motion: {
    enabled: true,
    stillThreshold: 2.0,
    fps: 4,
    width: 96,
    mode: "promote",
  },
};

/** Deep-merge a partial config over the defaults. */
export function mergeConfig(partial?: DeepPartial<PausecutConfig>): PausecutConfig {
  const base = structuredClone(defaultConfig);
  if (!partial) return base;
  return {
    vad: { ...base.vad, ...stripUndefined(partial.vad) },
    tiers: { ...base.tiers, ...stripUndefined(partial.tiers) },
    motion: { ...base.motion, ...stripUndefined(partial.motion) },
    range: partial.range ? { ...stripUndefined(partial.range) } : undefined,
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function stripUndefined<T extends object | undefined>(o: T): Partial<NonNullable<T>> {
  if (!o) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<NonNullable<T>>;
}

export function validateConfig(c: PausecutConfig): void {
  const t = c.tiers;
  if (!(t.cutMin < t.squeezeMin && t.squeezeMin < t.markerMin)) {
    throw new Error(`tiers must satisfy cutMin < squeezeMin < markerMin (got ${t.cutMin}, ${t.squeezeMin}, ${t.markerMin})`);
  }
  if (t.squeezeTo >= t.squeezeMin) {
    throw new Error(`tiers.squeezeTo (${t.squeezeTo}) must be shorter than tiers.squeezeMin (${t.squeezeMin})`);
  }
  if (t.padBefore + t.padAfter >= t.cutMin) {
    throw new Error(`padBefore + padAfter must be shorter than tiers.cutMin`);
  }
  if (c.vad.threshold <= 0 || c.vad.threshold >= 1) throw new Error("vad.threshold must be in (0,1)");
}
