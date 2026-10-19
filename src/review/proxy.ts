import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegBin, type MediaInfo } from "../media.js";

const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le"]);

/** Can a browser <video>/<audio> element play this file as-is? */
export function browserPlayable(info: MediaInfo): boolean {
  const container = (info.container ?? "").split(",");
  const okContainer = container.some((c) => ["mp4", "mov", "m4a", "webm", "matroska", "mp3", "ogg", "wav"].includes(c.trim()));
  if (!okContainer) return false;
  if (info.hasVideo && !BROWSER_VIDEO.has(info.videoCodec ?? "")) return false;
  if (!BROWSER_AUDIO.has(info.audioCodec ?? "")) return false;
  // mkv plays in Chromium only when codecs are web codecs; accept.
  return true;
}

/**
 * Transcode to a small browser-friendly proxy (720p H.264 / AAC, or AAC audio-only).
 * Cached in the OS temp dir keyed by path + size + mtime, so a second `review` is instant.
 */
export async function makeProxy(
  info: MediaInfo,
  opts: { log?: (s: string) => void; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const st = await fs.stat(info.path);
  const key = crypto.createHash("sha1").update(`${path.resolve(info.path)}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "pausecut-proxy");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${key}.${info.hasVideo ? "mp4" : "m4a"}`);
  try {
    await fs.access(out);
    opts.log?.(`using cached proxy ${out}`);
    return out;
  } catch {
    /* build it */
  }
  opts.log?.(`source is not browser-playable (${info.videoCodec ?? "-"}/${info.audioCodec}); making a proxy`);
  const args = ["-y", "-v", "error", "-stats", "-nostdin", "-i", info.path];
  if (info.hasVideo) {
    args.push("-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  } else {
    args.push("-vn");
  }
  args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2", out + ".tmp" + path.extname(out));
  const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d: Buffer) => {
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(d.toString());
    if (m && opts.onProgress) {
      const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
      opts.onProgress(Math.min(1, t / info.duration));
    }
  });
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0) throw new Error(`ffmpeg proxy transcode failed (${code})`);
  await fs.rename(out + ".tmp" + path.extname(out), out);
  return out;
}
