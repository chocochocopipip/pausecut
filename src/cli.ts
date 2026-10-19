#!/usr/bin/env node
import { Command, Option } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { analyze, prepare, type Analysis } from "./analyze.js";
import { ReviewServer } from "./review/server.js";
import { browserPlayable, makeProxy } from "./review/proxy.js";
import { spawn } from "node:child_process";
import { defaultConfig, mergeConfig, type DeepPartial, type PausecutConfig } from "./config.js";
import { presets } from "./presets.js";
import { toXmeml } from "./export/xmeml.js";
import { toEdl } from "./export/edl.js";
import { toCsv, summary } from "./export/report.js";
import { render } from "./export/render.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// `pausecut presets | head` closes stdout early; exit quietly instead of crashing.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const program = new Command();
program
  .name("pausecut")
  .description("Detect pauses in speech with Silero VAD and produce cut lists for Premiere Pro (XML/EDL) or render with ffmpeg.")
  .version(pkg.version);

function addTuning(cmd: Command): Command {
  return cmd
    .option("-c, --config <file>", "JSON config file (see `pausecut init`)")
    .addOption(new Option("-p, --preset <name>", "named preset").choices(Object.keys(presets)))
    .option("--cut-min <sec>", "gaps >= this are cut", parseFloat)
    .option("--squeeze-min <sec>", "gaps >= this are squeezed instead of cut", parseFloat)
    .option("--marker-min <sec>", "gaps >= this are kept and marked", parseFloat)
    .option("--squeeze-to <sec>", "length a squeezed gap is reduced to", parseFloat)
    .option("--pad <sec>", "silence kept on both sides of every cut", parseFloat)
    .option("--pad-before <sec>", "silence kept after speech ends", parseFloat)
    .option("--pad-after <sec>", "silence kept before speech starts", parseFloat)
    .option("--threshold <0-1>", "VAD speech probability threshold", parseFloat)
    .option("--min-speech <sec>", "discard speech bursts shorter than this", parseFloat)
    .option("--min-silence <sec>", "bridge silences shorter than this", parseFloat)
    .option("--no-motion", "skip on-screen motion analysis")
    .option("--still <value>", "motion score below which a gap counts as still (0-255)", parseFloat)
    .option("--start <sec>", "analyze from this time", parseFloat)
    .option("--end <sec>", "analyze until this time", parseFloat);
}

async function buildConfig(o: Record<string, any>): Promise<DeepPartial<PausecutConfig>> {
  let cfg: DeepPartial<PausecutConfig> = {};
  if (o.preset) cfg = structuredClone(presets[o.preset].config);
  if (o.config) {
    const file = JSON.parse(await fs.readFile(o.config, "utf8"));
    cfg = deepMerge(cfg, file);
  }
  const cli: DeepPartial<PausecutConfig> = {
    tiers: {
      cutMin: o.cutMin,
      squeezeMin: o.squeezeMin,
      markerMin: o.markerMin,
      squeezeTo: o.squeezeTo,
      padBefore: o.padBefore ?? o.pad,
      padAfter: o.padAfter ?? o.pad,
    },
    vad: { threshold: o.threshold, minSpeech: o.minSpeech, minSilence: o.minSilence },
    motion: { enabled: o.motion === false ? false : undefined, stillThreshold: o.still },
    range: o.start !== undefined || o.end !== undefined ? { start: o.start, end: o.end } : undefined,
  };
  return deepMerge(cfg, cli);
}

function deepMerge<T extends Record<string, any>>(a: T, b: T): T {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepMerge(out[k] ?? {}, v);
    else out[k] = v;
  }
  return out as T;
}

interface OutputOpts {
  outDir?: string;
  json?: boolean;
  csv?: boolean;
  xml?: boolean;
  edl?: boolean;
  render?: string;
  sourcePath?: string;
  name?: string;
  crf?: number;
  preset?: string;
  quiet?: boolean;
}

async function writeOutputs(a: Analysis, inputPath: string, o: OutputOpts): Promise<string[]> {
  const base = path.parse(inputPath).name;
  const dir = o.outDir ?? path.dirname(inputPath);
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const out = async (ext: string, content: string) => {
    const p = path.join(dir, `${base}.pausecut${ext}`);
    await fs.writeFile(p, content);
    written.push(p);
  };
  if (o.json !== false) await out(".json", JSON.stringify(a, null, 2));
  if (o.csv) await out(".csv", toCsv(a));
  if (o.xml) await out(".xml", toXmeml(a, { sourcePath: o.sourcePath, name: o.name }));
  if (o.edl) await out(".edl", toEdl(a, { title: o.name }));
  if (o.render) {
    await render(a, {
      output: o.render,
      crf: o.crf,
      preset: o.preset,
      log: o.quiet ? undefined : (l) => process.stderr.write(`\r${l}`),
    });
    if (!o.quiet) process.stderr.write("\n");
    written.push(o.render);
  }
  return written;
}

function addOutputs(cmd: Command): Command {
  return cmd
    .option("-d, --out-dir <dir>", "write outputs here (default: next to the input)")
    .option("--no-json", "do not write the analysis JSON")
    .option("--csv", "write a CSV report of every gap and its decision")
    .option("--xml", "write a Premiere Pro / FCP7 XML sequence")
    .option("--edl", "write a CMX3600 EDL")
    .option("--render <file>", "render the cut directly with ffmpeg")
    .option("--source-path <path>", "path to the media file as Premiere will see it (for the XML)")
    .option("--name <name>", "sequence name")
    .option("--crf <n>", "x264 CRF for --render (default 20)", parseFloat)
    .option("--encode-preset <name>", "x264 preset for --render (default fast)")
    .option("-q, --quiet", "no progress output");
}

addOutputs(addTuning(program.command("analyze", { isDefault: true })))
  .argument("<input>", "video or audio file")
  .description("analyze a file and write cut lists (default command)")
  .option("--all", "shortcut for --csv --xml --edl")
  .action(async (input: string, o: Record<string, any>) => {
    const log = o.quiet ? () => {} : (m: string) => process.stderr.write(`${m}\n`);
    const cfg = await buildConfig(o);
    const t0 = Date.now();
    let lastPct = -1;
    const a = await analyze(input, {
      config: cfg,
      log,
      onProgress: (stage, d, t) => {
        if (o.quiet) return;
        const pct = Math.floor((d / t) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\r${stage} ${pct}%`);
          if (d === t) process.stderr.write("\n");
        }
      },
    });
    const written = await writeOutputs(a, input, {
      ...o,
      csv: o.csv || o.all,
      xml: o.xml || o.all,
      edl: o.edl || o.all,
      preset: o.encodePreset,
    });
    if (!o.quiet) {
      process.stderr.write(`\n${summary(a)}\n`);
      process.stderr.write(`\nwritten (${((Date.now() - t0) / 1000).toFixed(1)}s):\n${written.map((w) => "  " + w).join("\n")}\n`);
    }
  });

addOutputs(program.command("export"))
  .argument("<analysis.json>", "a .pausecut.json produced by analyze (edit it by hand if you like)")
  .description("re-export outputs from a saved analysis without re-running VAD")
  .option("--all", "shortcut for --csv --xml --edl")
  .action(async (file: string, o: Record<string, any>) => {
    const a = JSON.parse(await fs.readFile(file, "utf8")) as Analysis;
    if (a.generator !== "pausecut") throw new Error("not a pausecut analysis file");
    // Recompute keep ranges/markers so hand-edited `action`s are honored.
    const { buildKeepRanges, buildMarkers } = await import("./gaps.js");
    a.keep = buildKeepRanges(a.gaps, a.source.duration);
    a.markers = buildMarkers(a.gaps, a.keep);
    const inputBase = file.replace(/\.pausecut\.json$/, "") + path.extname(a.source.path);
    const written = await writeOutputs(a, inputBase, {
      ...o,
      json: false,
      csv: o.csv || o.all,
      xml: o.xml || o.all,
      edl: o.edl || o.all,
      preset: o.encodePreset,
    });
    if (!o.quiet) process.stderr.write(`written:\n${written.map((w) => "  " + w).join("\n")}\n`);
  });

addTuning(program.command("review"))
  .argument("<input>", "video or audio file")
  .description("open a browser UI to review candidates, tune thresholds, preview the cut and export")
  .option("--port <n>", "port (default: random free port)", parseInt)
  .option("--host <host>", "bind address", "127.0.0.1")
  .option("--no-open", "do not open the browser automatically")
  .option("--no-proxy", "serve the original file even if the browser may not play it")
  .option("-d, --out-dir <dir>", "default output folder for exports (default: next to the input)")
  .option("--source-path <path>", "media path as Premiere will see it (for the XML)")
  .option("-q, --quiet", "no progress output")
  .action(async (input: string, o: Record<string, any>) => {
    const log = o.quiet ? () => {} : (m: string) => process.stderr.write(`${m}\n`);
    const cfg = await buildConfig(o);
    let lastPct = -1;
    const prepared = await prepare(input, {
      config: cfg,
      log,
      onProgress: (stage, d, t) => {
        if (o.quiet) return;
        const pct = Math.floor((d / t) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\r${stage} ${pct}%`);
          if (d === t) process.stderr.write("\n");
        }
      },
    });
    let mediaPath = prepared.source.path;
    if (o.proxy !== false && !browserPlayable(prepared.source)) {
      let last = -1;
      mediaPath = await makeProxy(prepared.source, {
        log,
        onProgress: (f) => {
          const pct = Math.floor(f * 100);
          if (!o.quiet && pct !== last) { last = pct; process.stderr.write(`\rproxy ${pct}%`); }
        },
      });
      if (!o.quiet) process.stderr.write("\n");
    }
    const server = new ReviewServer({
      prepared,
      config: cfg,
      mediaPath,
      outDir: path.resolve(o.outDir ?? path.dirname(input)),
      sourcePath: o.sourcePath,
      port: o.port,
      host: o.host,
      log,
    });
    const url = await server.listen();
    process.stderr.write(`\nreview UI: ${url}\n(Ctrl+C to stop)\n`);
    if (o.open !== false) openBrowser(url);
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => { server.close(); resolve(); });
      process.on("SIGTERM", () => { server.close(); resolve(); });
    });
  });

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch { /* the URL is printed anyway */ }
}

program
  .command("init")
  .description("write a pausecut.config.json with the defaults (or a preset) to edit")
  .addOption(new Option("-p, --preset <name>", "start from a preset").choices(Object.keys(presets)))
  .option("-o, --output <file>", "output path", "pausecut.config.json")
  .action(async (o: { preset?: string; output: string }) => {
    const cfg = mergeConfig(o.preset ? presets[o.preset].config : undefined);
    await fs.writeFile(o.output, JSON.stringify(cfg, null, 2) + "\n");
    process.stderr.write(`wrote ${o.output}\n`);
  });

program
  .command("presets")
  .description("list named presets")
  .action(() => {
    for (const [name, p] of Object.entries(presets)) {
      const t = mergeConfig(p.config).tiers;
      process.stdout.write(`${name.padEnd(12)} ${p.description}\n${"".padEnd(12)} cut ≥${t.cutMin}s  squeeze ≥${t.squeezeMin}s→${t.squeezeTo}s  marker ≥${t.markerMin}s  pad ${t.padBefore}/${t.padAfter}s\n`);
    }
    process.stdout.write(`\ndefault: cut ≥${defaultConfig.tiers.cutMin}s  squeeze ≥${defaultConfig.tiers.squeezeMin}s→${defaultConfig.tiers.squeezeTo}s  marker ≥${defaultConfig.tiers.markerMin}s\n`);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});

