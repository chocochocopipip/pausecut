export interface Timebase {
  /** Integer timebase used by NLEs (24, 25, 30, 60). */
  timebase: number;
  /** True for 23.976 / 29.97 / 59.94. */
  ntsc: boolean;
  /** Exact fps as a float. */
  fps: number;
}

export function timebaseFor(fps: number | undefined): Timebase {
  const f = fps && fps > 0 ? fps : 30;
  const candidates = [24, 25, 30, 48, 50, 60];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - f) < Math.abs(best - f)) best = c;
  const ntsc = Math.abs(best - f) > 0.01 && Math.abs(best / 1.001 - f) < 0.01;
  return { timebase: best, ntsc, fps: f };
}

export function toFrames(seconds: number, tb: Timebase): number {
  return Math.round(seconds * tb.fps);
}

/** Non-drop-frame timecode HH:MM:SS:FF using the integer timebase. */
export function framesToTimecode(frames: number, tb: Timebase): string {
  const fpsInt = tb.timebase;
  const ff = frames % fpsInt;
  const totalSec = Math.floor(frames / fpsInt);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s, ff].map((n) => String(n).padStart(2, "0")).join(":");
}
