import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Analysis } from "../analyze.js";
import { ffmpegBin } from "../media.js";

export interface RenderOptions {
  output: string;
  /** Extra ffmpeg output args, e.g. ["-crf", "18"]. */
  extraArgs?: string[];
  /** Video encoder (default libx264). */
  videoCodec?: string;
  /** Audio encoder (default aac). */
  audioCodec?: string;
  crf?: number;
  preset?: string;
  log?: (line: string) => void;
}

/**
 * Render the cut directly with ffmpeg (trim + concat). Useful for a quick
 * preview of the result before importing the XML into Premiere.
 */
export async function render(a: Analysis, opts: RenderOptions): Promise<void> {
  const hasVideo = a.source.hasVideo;
  const parts: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];
  a.keep.forEach((k, i) => {
    if (hasVideo) {
      parts.push(`[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`);
      vLabels.push(`[v${i}]`);
    }
    parts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`);
    aLabels.push(`[a${i}]`);
  });
  const n = a.keep.length;
  if (n === 0) throw new Error("nothing to render: no kept ranges");
  const concatInputs = a.keep.map((_, i) => (hasVideo ? `[v${i}][a${i}]` : `[a${i}]`)).join("");
  parts.push(`${concatInputs}concat=n=${n}:v=${hasVideo ? 1 : 0}:a=1${hasVideo ? "[outv][outa]" : "[outa]"}`);

  const scriptPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pausecut-")), "filter.txt");
  await fs.writeFile(scriptPath, parts.join(";\n"));

  const args = ["-y", "-v", "error", "-stats", "-nostdin", "-i", a.source.path, "-filter_complex_script", scriptPath];
  if (hasVideo) {
    args.push("-map", "[outv]", "-c:v", opts.videoCodec ?? "libx264", "-crf", String(opts.crf ?? 20), "-preset", opts.preset ?? "fast", "-pix_fmt", "yuv420p");
  }
  args.push("-map", "[outa]", "-c:a", opts.audioCodec ?? "aac", "-b:a", "192k");
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(opts.output);

  const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "inherit", "pipe"] });
  child.stderr.on("data", (d: Buffer) => opts.log?.(d.toString("utf8").trim()));
  const [code] = (await once(child, "close")) as [number];
  await fs.rm(path.dirname(scriptPath), { recursive: true, force: true });
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
}
