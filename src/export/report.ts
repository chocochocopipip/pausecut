import type { Analysis } from "../analyze.js";
import { sourceToOutput } from "../gaps.js";
import { fmt } from "../analyze.js";

export function toCsv(a: Analysis): string {
  const rows: string[][] = [[
    "index", "start", "end", "duration", "tier", "motion", "motion_level", "action", "removed_seconds", "output_time", "reason",
  ]];
  for (const g of a.gaps) {
    const out = sourceToOutput(a.keep, g.start);
    rows.push([
      String(g.index),
      g.start.toFixed(3),
      g.end.toFixed(3),
      g.duration.toFixed(3),
      g.tier,
      g.motion === undefined ? "" : g.motion.toFixed(2),
      g.motionLevel,
      g.action,
      g.saved.toFixed(3),
      out === undefined ? "" : out.toFixed(3),
      g.reason,
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function summary(a: Analysis): string {
  const s = a.stats;
  const lines = [
    `source   ${fmt(s.sourceDuration)}  →  output ${fmt(s.outputDuration)}  (−${fmt(s.removed)}, ${s.removedPercent}%)`,
    `speech   ${s.speechSegments} segments, ${s.gaps} gaps`,
  ];
  for (const [action, b] of Object.entries(s.byAction)) {
    lines.push(`  ${action.padEnd(8)} ${String(b.count).padStart(5)} gaps   ${fmt(b.seconds)} removed`);
  }
  if (a.markers.length) lines.push(`markers  ${a.markers.length} long pauses flagged for review`);
  return lines.join("\n");
}
