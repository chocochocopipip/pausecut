import type { GapAction, MotionLevel, PausecutConfig } from "./config.js";
import type { SpeechSegment } from "./vad.js";

export type GapTier = "micro" | "cut" | "squeeze" | "long" | "edge";

export interface Gap {
  index: number;
  /** Source time where speech stopped. */
  start: number;
  /** Source time where speech resumes. */
  end: number;
  duration: number;
  tier: GapTier;
  /** Mean absolute frame difference inside the gap (0-255), if motion analysis ran. */
  motion?: number;
  motionLevel: MotionLevel;
  action: GapAction;
  /** Source ranges removed by this gap's action. */
  removed: Array<{ start: number; end: number }>;
  /** Seconds removed. */
  saved: number;
  reason: string;
}

export interface KeepRange {
  /** Source in/out (seconds). */
  start: number;
  end: number;
  /** Position of this range in the output timeline (seconds). */
  outStart: number;
}

export interface Marker {
  /** Time in the output timeline. */
  time: number;
  sourceTime: number;
  duration: number;
  label: string;
}

/** Find gaps between speech segments. */
export function findGaps(speech: SpeechSegment[], duration: number): Array<{ start: number; end: number; edge: boolean }> {
  const gaps: Array<{ start: number; end: number; edge: boolean }> = [];
  if (speech.length === 0) return [{ start: 0, end: duration, edge: true }];
  if (speech[0].start > 0) gaps.push({ start: 0, end: speech[0].start, edge: true });
  for (let i = 0; i < speech.length - 1; i++) {
    gaps.push({ start: speech[i].end, end: speech[i + 1].start, edge: false });
  }
  const last = speech[speech.length - 1];
  if (last.end < duration) gaps.push({ start: last.end, end: duration, edge: true });
  return gaps;
}

export function tierOf(duration: number, cfg: PausecutConfig): Exclude<GapTier, "edge"> {
  const t = cfg.tiers;
  if (duration < t.cutMin) return "micro";
  if (duration < t.squeezeMin) return "cut";
  if (duration < t.markerMin) return "squeeze";
  return "long";
}

/**
 * Decide what to do with each gap, applying the tier rules and (optionally) the
 * motion-based promotion/demotion.
 */
export function classifyGaps(
  rawGaps: Array<{ start: number; end: number; edge: boolean; motion?: number }>,
  cfg: PausecutConfig,
): Gap[] {
  const t = cfg.tiers;
  const m = cfg.motion;
  const out: Gap[] = [];

  rawGaps.forEach((g, index) => {
    const duration = g.end - g.start;
    let motionLevel: MotionLevel = "unknown";
    if (g.motion !== undefined) motionLevel = g.motion < m.stillThreshold ? "still" : "active";

    let tier: GapTier = g.edge ? "edge" : tierOf(duration, cfg);
    let action: GapAction;
    let reason: string;

    if (tier === "edge") {
      if (duration > t.cutMin) {
        action = "cut";
        reason = "leading/trailing silence";
      } else {
        action = "keep";
        reason = "short edge";
      }
    } else if (tier === "micro") {
      action = "keep";
      reason = `shorter than cutMin (${t.cutMin}s)`;
    } else {
      // Base decision from duration.
      const base: GapAction = tier === "cut" ? "cut" : tier === "squeeze" ? "squeeze" : "marker";
      action = base;
      reason = `${tier} tier`;
      if (m.enabled && m.mode === "promote" && motionLevel !== "unknown") {
        if (motionLevel === "still") {
          if (tier === "squeeze") { action = "cut"; reason = "squeeze tier, no on-screen motion → cut"; }
          else if (tier === "long") { action = "squeeze"; reason = "long tier, no on-screen motion → squeeze"; }
        } else if (motionLevel === "active") {
          if (tier === "squeeze") { action = "keep"; reason = "squeeze tier, on-screen motion → keep"; }
          else if (tier === "long") { action = "marker"; reason = "long tier, on-screen motion → marker"; }
        }
      }
    }

    const removed = removalFor({ start: g.start, end: g.end, edge: g.edge, isHead: g.edge && g.start === 0 }, action, cfg);
    const saved = removed.reduce((s, r) => s + (r.end - r.start), 0);
    out.push({
      index,
      start: round(g.start),
      end: round(g.end),
      duration: round(duration),
      tier,
      motion: g.motion === undefined ? undefined : round(g.motion, 2),
      motionLevel,
      action,
      removed: removed.map((r) => ({ start: round(r.start), end: round(r.end) })),
      saved: round(saved),
      reason,
    });
  });
  return out;
}

/** Re-apply an action to an existing gap (user override), recomputing `removed`/`saved`. */
export function applyAction(gap: Gap, action: GapAction, cfg: PausecutConfig, reason = "manual override"): Gap {
  const removed = removalFor(
    { start: gap.start, end: gap.end, edge: gap.tier === "edge", isHead: gap.tier === "edge" && gap.index === 0 },
    action,
    cfg,
  );
  return {
    ...gap,
    action,
    reason,
    removed: removed.map((r) => ({ start: round(r.start), end: round(r.end) })),
    saved: round(removed.reduce((s, r) => s + (r.end - r.start), 0)),
  };
}

function removalFor(
  g: { start: number; end: number; edge: boolean; isHead: boolean },
  action: GapAction,
  cfg: PausecutConfig,
): Array<{ start: number; end: number }> {
  const t = cfg.tiers;
  if (action === "keep" || action === "marker") return [];
  if (g.edge) {
    // Head: keep padAfter before speech. Tail: keep padBefore after speech.
    return g.isHead
      ? [{ start: g.start, end: Math.max(g.start, g.end - t.padAfter) }]
      : [{ start: Math.min(g.end, g.start + t.padBefore), end: g.end }];
  }
  if (action === "cut") {
    const s = g.start + t.padBefore;
    const e = g.end - t.padAfter;
    return e > s ? [{ start: s, end: e }] : [];
  }
  // squeeze: keep a head and a tail, drop the middle → one jump cut per gap.
  const head = Math.max(t.padBefore, t.squeezeTo / 2);
  const tail = Math.max(t.padAfter, t.squeezeTo / 2);
  const s = g.start + head;
  const e = g.end - tail;
  return e > s ? [{ start: s, end: e }] : [];
}

/** Build the ordered list of source ranges to keep, with their output positions. */
export function buildKeepRanges(gaps: Gap[], duration: number): KeepRange[] {
  const removed = gaps.flatMap((g) => g.removed).sort((a, b) => a.start - b.start);
  const keep: KeepRange[] = [];
  let cursor = 0;
  let outCursor = 0;
  for (const r of removed) {
    if (r.start > cursor) {
      keep.push({ start: cursor, end: r.start, outStart: outCursor });
      outCursor += r.start - cursor;
    }
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration, outStart: outCursor });
  return keep.map((k) => ({ start: round(k.start), end: round(k.end), outStart: round(k.outStart) }));
}

/** Map a source time to the output timeline (undefined if it was removed). */
export function sourceToOutput(keep: KeepRange[], t: number): number | undefined {
  for (const k of keep) {
    if (t >= k.start && t <= k.end) return k.outStart + (t - k.start);
  }
  return undefined;
}

export function buildMarkers(gaps: Gap[], keep: KeepRange[]): Marker[] {
  const markers: Marker[] = [];
  for (const g of gaps) {
    if (g.action !== "marker") continue;
    const time = sourceToOutput(keep, g.start);
    if (time === undefined) continue;
    markers.push({
      time: round(time),
      sourceTime: g.start,
      duration: g.duration,
      label: `pause ${g.duration.toFixed(1)}s (${g.motionLevel})`,
    });
  }
  return markers;
}

export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
