import { spawn } from "node:child_process";
import { once } from "node:events";

export interface MediaInfo {
  path: string;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  /** Frames per second as a float (e.g. 29.97). */
  fps?: number;
  /** Frame rate as a rational string from ffprobe (e.g. "30000/1001"). */
  fpsRational?: string;
  audioChannels?: number;
  audioSampleRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
}

export function ffmpegBin(): string {
  return process.env.PAUSECUT_FFMPEG ?? "ffmpeg";
}
export function ffprobeBin(): string {
  return process.env.PAUSECUT_FFPROBE ?? "ffprobe";
}

async function run(bin: string, args: string[], opts: { binary?: boolean } = {}): Promise<Buffer> {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  child.stderr.on("data", (d: Buffer) => errChunks.push(d));
  const [code] = (await once(child, "close")) as [number];
  if (code !== 0) {
    const err = Buffer.concat(errChunks).toString("utf8");
    throw new Error(`${bin} exited with code ${code}\n${err.split("\n").slice(-15).join("\n")}`);
  }
  return Buffer.concat(chunks);
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await run(ffprobeBin(), [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    path,
  ]);
  const j = JSON.parse(out.toString("utf8"));
  const v = (j.streams as any[]).find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  const a = (j.streams as any[]).find((s) => s.codec_type === "audio");
  if (!a) throw new Error(`no audio stream in ${path}`);
  const duration = parseFloat(j.format?.duration ?? a.duration ?? v?.duration ?? "0");
  const info: MediaInfo = {
    path,
    duration,
    hasVideo: !!v,
    hasAudio: true,
    audioChannels: a.channels,
    audioSampleRate: parseInt(a.sample_rate, 10),
    audioCodec: a.codec_name,
    container: j.format?.format_name,
  };
  if (v) {
    info.width = v.width;
    info.height = v.height;
    info.videoCodec = v.codec_name;
    const r: string = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate;
    info.fpsRational = r;
    const [n, d] = r.split("/").map(Number);
    info.fps = d ? n / d : n;
  }
  return info;
}

/**
 * Decode audio to mono 16 kHz float32 PCM in memory.
 * Roughly 64 KB per second of audio; a 2-hour recording is ~460 MB, fine for Node.
 */
export async function extractPcm16k(
  path: string,
  range?: { start?: number; end?: number },
): Promise<Float32Array> {
  const args = ["-v", "error", "-nostdin"];
  if (range?.start) args.push("-ss", String(range.start));
  args.push("-i", path);
  if (range?.end) args.push("-to", String(range.end - (range.start ?? 0)));
  args.push(
    "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", "16000",
    "-f", "f32le", "-acodec", "pcm_f32le",
    "pipe:1",
  );
  const buf = await run(ffmpegBin(), args);
  // Ensure 4-byte alignment for the Float32Array view.
  const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

/**
 * Stream tiny grayscale frames for motion analysis.
 * Returns one Uint8Array per frame at `fps`, plus the frame geometry.
 */
export async function extractGrayFrames(
  path: string,
  opts: { fps: number; width: number; start?: number; end?: number },
): Promise<{ frames: Uint8Array[]; width: number; height: number; fps: number }> {
  // Figure out the output height from the source aspect ratio.
  const info = await probe(path);
  if (!info.hasVideo || !info.width || !info.height) throw new Error("no video stream for motion analysis");
  const height = Math.max(2, Math.round((opts.width * info.height) / info.width / 2) * 2);
  const args = ["-v", "error", "-nostdin"];
  if (opts.start) args.push("-ss", String(opts.start));
  args.push("-i", path);
  if (opts.end) args.push("-to", String(opts.end - (opts.start ?? 0)));
  args.push(
    "-an", "-sn", "-dn",
    "-vf", `fps=${opts.fps},scale=${opts.width}:${height}:flags=area,format=gray`,
    "-f", "rawvideo", "-pix_fmt", "gray",
    "pipe:1",
  );
  const buf = await run(ffmpegBin(), args);
  const frameSize = opts.width * height;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + frameSize <= buf.length; off += frameSize) {
    frames.push(new Uint8Array(buf.buffer, buf.byteOffset + off, frameSize));
  }
  return { frames, width: opts.width, height, fps: opts.fps };
}

export { run as runProcess };
