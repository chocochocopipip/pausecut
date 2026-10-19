import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Analysis, type Prepared, decide, finalize, fmt } from "../analyze.js";
import { mergeConfig, type DeepPartial, type GapAction, type PausecutConfig } from "../config.js";
import { applyAction } from "../gaps.js";
import { toXmeml } from "../export/xmeml.js";
import { toEdl } from "../export/edl.js";
import { toCsv } from "../export/report.js";
import { render } from "../export/render.js";

export interface ReviewServerOptions {
  prepared: Prepared;
  config: DeepPartial<PausecutConfig>;
  /** File served to the browser (the source, or a proxy). */
  mediaPath: string;
  /** Where apply writes outputs. */
  outDir: string;
  /** Media path as Premiere should see it. */
  sourcePath?: string;
  port?: number;
  host?: string;
  log?: (s: string) => void;
}

type GapKey = string;
const keyOf = (g: { start: number; end: number }) => `${g.start.toFixed(3)}-${g.end.toFixed(3)}`;

interface ApplyRequest {
  json?: boolean;
  csv?: boolean;
  xml?: boolean;
  edl?: boolean;
  render?: boolean;
  renderOutput?: string;
  crf?: number;
  outDir?: string;
  name?: string;
}

interface Job {
  id: number;
  status: "running" | "done" | "error";
  progress: number;
  log: string[];
  written: string[];
  error?: string;
}

export class ReviewServer {
  private config: DeepPartial<PausecutConfig>;
  private overrides = new Map<GapKey, GapAction>();
  private analysis: Analysis;
  private job: Job | null = null;
  private server: http.Server;
  private log: (s: string) => void;

  constructor(private opts: ReviewServerOptions) {
    this.config = structuredClone(opts.config);
    this.log = opts.log ?? (() => {});
    this.analysis = this.recompute();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: Error) => {
        this.log(`request error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
  }

  listen(): Promise<string> {
    const host = this.opts.host ?? "127.0.0.1";
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port ?? 0, host, () => {
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
        resolve(`http://${host}:${port}/`);
      });
    });
  }

  close(): void {
    this.server.close();
  }

  // ---- state -----------------------------------------------------------------

  private recompute(): Analysis {
    const a = decide(this.opts.prepared, this.config);
    const cfg = a.config;
    let touched = false;
    const gaps = a.gaps.map((g) => {
      const o = this.overrides.get(keyOf(g));
      if (o === undefined || o === g.action) return g;
      touched = true;
      return applyAction(g, o, cfg);
    });
    this.analysis = touched ? finalize({ ...a, gaps }) : a;
    return this.analysis;
  }

  private state() {
    const a = this.analysis;
    const overridden: Record<string, GapAction> = {};
    for (const g of a.gaps) {
      const o = this.overrides.get(keyOf(g));
      if (o !== undefined) overridden[g.index] = o;
    }
    return {
      analysis: a,
      config: a.config,
      overrides: overridden,
      media: { url: "/media", isProxy: path.resolve(this.opts.mediaPath) !== path.resolve(a.source.path) },
      outDir: this.opts.outDir,
      sourceName: path.basename(a.source.path),
      job: this.job,
    };
  }

  // ---- http ------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = await fsp.readFile(uiPath(), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && p === "/media") return this.serveMedia(req, res);
    if (req.method === "GET" && p === "/api/state") return json(res, this.state());

    if (req.method === "POST" && p === "/api/config") {
      const body = (await readJson(req)) as { config?: DeepPartial<PausecutConfig>; reset?: boolean };
      if (body.reset) this.config = structuredClone(this.opts.config);
      else this.config = deepMerge(this.config, body.config ?? {});
      try {
        this.recompute();
      } catch (err) {
        return json(res, { error: (err as Error).message }, 400);
      }
      return json(res, this.state());
    }

    if (req.method === "POST" && p === "/api/override") {
      const body = (await readJson(req)) as { index: number; action: GapAction | null };
      const g = this.analysis.gaps[body.index];
      if (!g) return json(res, { error: "no such gap" }, 400);
      if (body.action === null) this.overrides.delete(keyOf(g));
      else this.overrides.set(keyOf(g), body.action);
      this.recompute();
      return json(res, this.state());
    }

    if (req.method === "POST" && p === "/api/overrides/clear") {
      this.overrides.clear();
      this.recompute();
      return json(res, this.state());
    }

    if (req.method === "POST" && p === "/api/apply") {
      if (this.job?.status === "running") return json(res, { error: "a job is already running" }, 409);
      const body = (await readJson(req)) as ApplyRequest;
      this.startApply(body);
      return json(res, { job: this.job });
    }

    if (req.method === "GET" && p === "/api/job") return json(res, { job: this.job });

    res.writeHead(404);
    res.end("not found");
  }

  private async serveMedia(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const file = this.opts.mediaPath;
    const st = await fsp.stat(file);
    const type = mimeFor(file);
    const rangeHeader = req.headers.range;
    if (!rangeHeader) {
      res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { "content-range": `bytes */${st.size}` });
      res.end();
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${st.size}`,
      "accept-ranges": "bytes",
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  }

  // ---- apply -----------------------------------------------------------------

  private startApply(req: ApplyRequest): void {
    const job: Job = { id: (this.job?.id ?? 0) + 1, status: "running", progress: 0, log: [], written: [] };
    this.job = job;
    const a = this.analysis;
    const outDir = req.outDir ?? this.opts.outDir;
    const base = path.parse(a.source.path).name;
    const say = (s: string) => {
      job.log.push(s);
      this.log(s);
    };

    (async () => {
      await fsp.mkdir(outDir, { recursive: true });
      const out = async (ext: string, content: string) => {
        const p = path.join(outDir, `${base}.pausecut${ext}`);
        await fsp.writeFile(p, content);
        job.written.push(p);
        say(`wrote ${p}`);
      };
      if (req.json !== false) await out(".json", JSON.stringify(a, null, 2));
      if (req.csv) await out(".csv", toCsv(a));
      if (req.xml) await out(".xml", toXmeml(a, { sourcePath: this.opts.sourcePath, name: req.name }));
      if (req.edl) await out(".edl", toEdl(a, { title: req.name }));
      if (req.render) {
        const output = req.renderOutput && req.renderOutput.trim()
          ? path.resolve(outDir, req.renderOutput.trim())
          : path.join(outDir, `${base}_cut${a.source.hasVideo ? ".mp4" : ".m4a"}`);
        say(`rendering ${output} (${fmt(a.stats.outputDuration)})`);
        await render(a, {
          output,
          crf: req.crf,
          log: (line) => {
            const m = /time=(\d+):(\d+):([\d.]+)/.exec(line);
            if (m) {
              const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
              job.progress = Math.min(0.99, t / Math.max(1, a.stats.outputDuration));
            }
          },
        });
        job.written.push(output);
        say(`rendered ${output}`);
      }
      job.progress = 1;
      job.status = "done";
    })().catch((err: Error) => {
      job.status = "error";
      job.error = err.message;
      say(`error: ${err.message}`);
    });
  }
}

// ---- helpers -----------------------------------------------------------------

export function uiPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "ui", "index.html");
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
      ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
    }[ext] ?? "application/octet-stream"
  );
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

export { mergeConfig };
