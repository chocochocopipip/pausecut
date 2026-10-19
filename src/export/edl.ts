import path from "node:path";
import type { Analysis } from "../analyze.js";
import { timebaseFor, framesToTimecode } from "./timecode.js";
import { snapRanges } from "./xmeml.js";

/** CMX 3600 EDL. One V and one A event per kept range, reel "AX". */
export function toEdl(a: Analysis, opts: { title?: string } = {}): string {
  const tb = timebaseFor(a.source.fps);
  const clips = snapRanges(a, tb);
  const name = path.basename(a.source.path);
  const lines: string[] = [];
  lines.push(`TITLE: ${opts.title ?? path.parse(a.source.path).name + " (pausecut)"}`);
  lines.push(`FCM: NON-DROP FRAME`);
  lines.push("");
  const tc = (f: number) => framesToTimecode(f, tb);
  let ev = 1;
  for (const c of clips) {
    const n = String(ev).padStart(3, "0");
    if (a.source.hasVideo) {
      lines.push(`${n}  AX       V     C        ${tc(c.in)} ${tc(c.out)} ${tc(c.outStart)} ${tc(c.outEnd)}`);
    }
    lines.push(`${n}  AX       AA    C        ${tc(c.in)} ${tc(c.out)} ${tc(c.outStart)} ${tc(c.outEnd)}`);
    lines.push(`* FROM CLIP NAME: ${name}`);
    lines.push("");
    ev++;
  }
  return lines.join("\n");
}
