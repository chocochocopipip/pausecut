import { extractGrayFrames } from "./media.js";
import type { MotionConfig } from "./config.js";

/** Frame-to-frame difference series for a whole file (or range). Computed once, scored many times. */
export interface MotionSeries {
  /** diffs[i] is the mean |frame[i+1] - frame[i]| on a 0-255 scale; it sits at time offset + (i+1)/fps. */
  diffs: Float32Array;
  fps: number;
  offset: number;
}

export async function motionSeries(
  path: string,
  cfg: Pick<MotionConfig, "fps" | "width">,
  range?: { start?: number; end?: number },
): Promise<MotionSeries> {
  const { frames, fps } = await extractGrayFrames(path, {
    fps: cfg.fps,
    width: cfg.width,
    start: range?.start,
    end: range?.end,
  });
  const diffs = new Float32Array(Math.max(0, frames.length - 1));
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    let acc = 0;
    for (let p = 0; p < a.length; p++) acc += Math.abs(a[p] - b[p]);
    diffs[i - 1] = acc / a.length;
  }
  return { diffs, fps, offset: range?.start ?? 0 };
}

/**
 * Per-gap motion score: mean absolute difference between consecutive
 * downscaled grayscale frames, averaged over the gap. A static game board
 * with a cursor hovering is typically < 1, a hand moving cards 3-10, a scene
 * change 30+.
 */
export function scoreGaps(series: MotionSeries, gaps: Array<{ start: number; end: number }>): Array<number | undefined> {
  const { diffs, fps, offset } = series;
  return gaps.map((g) => {
    const first = Math.ceil((g.start - offset) * fps);
    const last = Math.floor((g.end - offset) * fps) - 1;
    if (last < first || first < 0 || first >= diffs.length) return undefined;
    let acc = 0;
    let n = 0;
    for (let i = first; i <= Math.min(last, diffs.length - 1); i++) {
      acc += diffs[i];
      n++;
    }
    return n ? acc / n : undefined;
  });
}

/** Convenience wrapper: extract + score in one go. */
export async function motionPerGap(
  path: string,
  gaps: Array<{ start: number; end: number }>,
  cfg: MotionConfig,
  range?: { start?: number; end?: number },
): Promise<Array<number | undefined>> {
  if (gaps.length === 0) return [];
  return scoreGaps(await motionSeries(path, cfg, range), gaps);
}
