import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { VadConfig } from "./config.js";

const require = createRequire(import.meta.url);
// onnxruntime-node is CommonJS; load lazily so `pausecut --help` stays fast.
type Ort = typeof import("onnxruntime-node");

export interface SpeechSegment {
  start: number;
  end: number;
}

const SAMPLE_RATE = 16000;
const WINDOW = 512; // samples per inference step at 16 kHz (32 ms)
const CONTEXT = 64; // Silero v5 prepends the last 64 samples of the previous window
const STATE_SHAPE = [2, 1, 128];

export function modelPath(): string {
  if (process.env.PAUSECUT_MODEL) return process.env.PAUSECUT_MODEL;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "models", "silero_vad.onnx");
}

/**
 * Run Silero VAD over mono 16 kHz PCM and return per-window speech probabilities.
 */
export async function speechProbabilities(
  pcm: Float32Array,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array> {
  const ort: Ort = require("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath(), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });

  const nWindows = Math.ceil(pcm.length / WINDOW);
  const probs = new Float32Array(nWindows);
  let state: Float32Array = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  const context = new Float32Array(CONTEXT);
  const input = new Float32Array(CONTEXT + WINDOW);
  const srTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

  for (let w = 0; w < nWindows; w++) {
    input.set(context, 0);
    const off = w * WINDOW;
    const chunk = pcm.subarray(off, off + WINDOW);
    input.fill(0, CONTEXT);
    input.set(chunk, CONTEXT);

    const out = await session.run({
      input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
      sr: srTensor,
      state: new ort.Tensor("float32", state, STATE_SHAPE),
    });
    probs[w] = (out.output.data as Float32Array)[0];
    state = out.stateN.data as Float32Array;
    context.set(input.subarray(input.length - CONTEXT));
    if (onProgress && (w % 500 === 0 || w === nWindows - 1)) onProgress(w + 1, nWindows);
  }
  return probs;
}

/**
 * Turn window probabilities into speech segments, following the logic of
 * silero's get_speech_timestamps (hysteresis + min durations + padding).
 */
export function probabilitiesToSegments(
  probs: Float32Array,
  cfg: VadConfig,
  totalDuration: number,
): SpeechSegment[] {
  const stepSec = WINDOW / SAMPLE_RATE;
  const threshold = cfg.threshold;
  const neg = cfg.negThreshold ?? Math.max(threshold - 0.15, 0.01);
  const minSilenceWin = Math.round(cfg.minSilence / stepSec);
  const minSpeechWin = Math.round(cfg.minSpeech / stepSec);

  const raw: Array<{ s: number; e: number }> = [];
  let inSpeech = false;
  let segStart = 0;
  let silenceStart = -1;

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!inSpeech) {
      if (p >= threshold) {
        inSpeech = true;
        segStart = i;
        silenceStart = -1;
      }
      continue;
    }
    if (p >= threshold) {
      silenceStart = -1;
      continue;
    }
    if (p < neg) {
      if (silenceStart < 0) silenceStart = i;
      if (i - silenceStart >= minSilenceWin) {
        raw.push({ s: segStart, e: silenceStart });
        inSpeech = false;
        silenceStart = -1;
      }
    }
    // neg <= p < threshold: ambiguous, stay in speech, don't start a silence run
    else silenceStart = -1;
  }
  if (inSpeech) raw.push({ s: segStart, e: silenceStart >= 0 ? silenceStart : probs.length });

  const segs: SpeechSegment[] = [];
  for (const r of raw) {
    if (r.e - r.s < minSpeechWin) continue;
    const start = Math.max(0, r.s * stepSec - cfg.speechPad);
    const end = Math.min(totalDuration, r.e * stepSec + cfg.speechPad);
    const last = segs[segs.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else segs.push({ start, end });
  }
  return segs;
}
