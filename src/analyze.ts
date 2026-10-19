import { mergeConfig, validateConfig, type DeepPartial, type PausecutConfig } from "./config.js";
import { probe, extractPcm16k, type MediaInfo } from "./media.js";
import { speechProbabilities, probabilitiesToSegments, type SpeechSegment } from "./vad.js";
import { findGaps, classifyGaps, buildKeepRanges, buildMarkers, round, type Gap, type KeepRange, type Marker } from "./gaps.js";
import { motionSeries, scoreGaps, type MotionSeries } from "./motion.js";

export interface AnalysisStats {
  sourceDuration: number;
  outputDuration: number;
  removed: number;
  removedPercent: number;
  speechSegments: number;
  gaps: number;
  byAction: Record<string, { count: number; seconds: number }>;
}

export interface Analysis {
  version: 1;
  generator: string;
  createdAt: string;
  source: MediaInfo;
  config: PausecutConfig;
  speech: SpeechSegment[];
  gaps: Gap[];
  keep: KeepRange[];
  markers: Marker[];
  stats: AnalysisStats;
}

export interface AnalyzeOptions {
  config?: DeepPartial<PausecutConfig>;
  log?: (msg: string) => void;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/**
 * The expensive, threshold-independent part of an analysis: VAD probabilities
 * for every 32 ms window and the frame-difference series. Keep one of these
 * around and call `decide()` as often as the thresholds change.
 */
export interface Prepared {
  source: MediaInfo;
  range: { start: number; end: number };
  probs: Float32Array;
  motion?: MotionSeries;
}

export async function prepare(path: string, opts: AnalyzeOptions = {}): Promise<Prepared> {
  const cfg = mergeConfig(opts.config);
  validateConfig(cfg);
  const log = opts.log ?? (() => {});

  const source = await probe(path);
  const range = { start: cfg.range?.start ?? 0, end: cfg.range?.end ?? source.duration };

  log(`decoding audio (${fmt(range.end - range.start)})`);
  const pcm = await extractPcm16k(path, cfg.range);

  log(`running VAD`);
  const probs = await speechProbabilities(pcm, (d, t) => opts.onProgress?.("vad", d, t));

  let motion: MotionSeries | undefined;
  if (cfg.motion.enabled && source.hasVideo) {
    log(`measuring on-screen motion`);
    motion = await motionSeries(path, cfg.motion, cfg.range);
  }
  return { source, range, probs, motion };
}

/** Apply thresholds to a prepared analysis. Pure and fast (milliseconds). */
export function decide(p: Prepared, config?: DeepPartial<PausecutConfig>): Analysis {
  const cfg = mergeConfig(config);
  validateConfig(cfg);
  const { source, range } = p;

  const speech = probabilitiesToSegments(p.probs, cfg.vad, range.end - range.start).map((s) => ({
    start: round(s.start + range.start),
    end: round(s.end + range.start),
  }));

  const rawGaps = findGaps(speech, source.duration).filter((g) => g.end > range.start && g.start < range.end);
  for (const g of rawGaps) {
    g.start = Math.max(g.start, range.start);
    g.end = Math.min(g.end, range.end);
  }

  let gapsWithMotion: Array<{ start: number; end: number; edge: boolean; motion?: number }> = rawGaps;
  if (cfg.motion.enabled && p.motion) {
    const scores = scoreGaps(p.motion, rawGaps);
    gapsWithMotion = rawGaps.map((g, i) => ({ ...g, motion: scores[i] }));
  }

  const gaps = classifyGaps(gapsWithMotion, cfg);
  return finalize({ source, config: cfg, speech, gaps });
}

/** Recompute keep ranges, markers and stats from a (possibly hand-edited) gap list. */
export function finalize(a: { source: MediaInfo; config: PausecutConfig; speech: SpeechSegment[]; gaps: Gap[] }): Analysis {
  const keep = buildKeepRanges(a.gaps, a.source.duration);
  const markers = buildMarkers(a.gaps, keep);
  const removed = a.gaps.reduce((s, g) => s + g.saved, 0);
  const byAction: AnalysisStats["byAction"] = {};
  for (const g of a.gaps) {
    const b = (byAction[g.action] ??= { count: 0, seconds: 0 });
    b.count++;
    b.seconds = round(b.seconds + g.saved);
  }
  const d = a.source.duration;
  return {
    version: 1,
    generator: "pausecut",
    createdAt: new Date().toISOString(),
    source: a.source,
    config: a.config,
    speech: a.speech,
    gaps: a.gaps,
    keep,
    markers,
    stats: {
      sourceDuration: round(d),
      outputDuration: round(d - removed),
      removed: round(removed),
      removedPercent: round((removed / d) * 100, 1),
      speechSegments: a.speech.length,
      gaps: a.gaps.length,
      byAction,
    },
  };
}

export async function analyze(path: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const p = await prepare(path, opts);
  const a = decide(p, opts.config);
  opts.log?.(`${a.speech.length} speech segments, ${a.gaps.length} gaps`);
  return a;
}

export function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? `${h}:` : "") + `${String(m).padStart(h ? 2 : 1, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}
