import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Analysis } from "../analyze.js";
import { timebaseFor, toFrames, type Timebase } from "./timecode.js";

/**
 * Final Cut Pro 7 XML (xmeml v4), the interchange format Premiere Pro imports
 * via File > Import. Produces one sequence with the kept ranges laid out
 * back-to-back on V1 (if video) and A1/A2, plus sequence markers for the gaps
 * flagged for manual review.
 */
export function toXmeml(a: Analysis, opts: { name?: string; sourcePath?: string } = {}): string {
  const src = a.source;
  const tb = timebaseFor(src.fps);
  const srcPath = path.resolve(opts.sourcePath ?? src.path);
  const seqName = opts.name ?? `${path.parse(srcPath).name} (pausecut)`;
  const fileName = path.basename(srcPath);
  const fileDurationFrames = toFrames(src.duration, tb);
  const channels = Math.min(2, Math.max(1, src.audioChannels ?? 2));
  const sampleRate = src.audioSampleRate ?? 48000;

  // Frame-snap kept ranges and lay them out contiguously.
  const clips = snapRanges(a, tb);
  const totalFrames = clips.length ? clips[clips.length - 1].outEnd : 0;

  const rateXml = `<rate><timebase>${tb.timebase}</timebase><ntsc>${tb.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;

  const fileXml = (full: boolean) =>
    full
      ? `<file id="file-1">
            <name>${esc(fileName)}</name>
            <pathurl>${esc(pathUrl(srcPath))}</pathurl>
            ${rateXml}
            <duration>${fileDurationFrames}</duration>
            <timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
            <media>
              ${src.hasVideo ? `<video><samplecharacteristics>${rateXml}<width>${src.width}</width><height>${src.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : ""}
              <audio><samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio>
            </media>
          </file>`
      : `<file id="file-1"/>`;

  const videoClip = (c: SnappedClip, i: number, first: boolean) => `
        <clipitem id="clipitem-v${i}">
          <name>${esc(fileName)}</name>
          <enabled>TRUE</enabled>
          <duration>${fileDurationFrames}</duration>
          ${rateXml}
          <start>${c.outStart}</start>
          <end>${c.outEnd}</end>
          <in>${c.in}</in>
          <out>${c.out}</out>
          ${fileXml(first)}
          <sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>
          ${linkXml(i, channels, src.hasVideo)}
        </clipitem>`;

  const audioClip = (c: SnappedClip, i: number, ch: number, first: boolean) => `
        <clipitem id="clipitem-a${ch}-${i}">
          <name>${esc(fileName)}</name>
          <enabled>TRUE</enabled>
          <duration>${fileDurationFrames}</duration>
          ${rateXml}
          <start>${c.outStart}</start>
          <end>${c.outEnd}</end>
          <in>${c.in}</in>
          <out>${c.out}</out>
          ${fileXml(first)}
          <sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>
          ${linkXml(i, channels, src.hasVideo)}
        </clipitem>`;

  const videoTrack = src.hasVideo
    ? `<track>${clips.map((c, i) => videoClip(c, i, i === 0)).join("")}
        <enabled>TRUE</enabled><locked>FALSE</locked></track>`
    : "";

  const audioTracks = Array.from({ length: channels }, (_, k) => k + 1)
    .map(
      (ch) => `<track>${clips.map((c, i) => audioClip(c, i, ch, !src.hasVideo && ch === 1 && i === 0)).join("")}
        <enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${ch}</outputchannelindex></track>`,
    )
    .join("\n      ");

  const markersXml = a.markers
    .map(
      (m) => `
    <marker>
      <name>${esc(m.label)}</name>
      <comment>${esc(`source ${m.sourceTime.toFixed(2)}s, ${m.duration.toFixed(2)}s pause`)}</comment>
      <in>${toFrames(m.time, tb)}</in>
      <out>-1</out>
    </marker>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(seqName)}</name>
    <duration>${totalFrames}</duration>
    ${rateXml}
    <timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      ${src.hasVideo ? `<video>
      <format><samplecharacteristics>${rateXml}<width>${src.width}</width><height>${src.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
      ${videoTrack}
      </video>` : ""}
      <audio>
      <format><samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics></format>
      <outputs>${Array.from({ length: channels }, (_, k) => `<group><index>${k + 1}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${k + 1}</index></channel></group>`).join("")}</outputs>
      ${audioTracks}
      </audio>
    </media>${markersXml}
  </sequence>
</xmeml>
`;
}

export interface SnappedClip {
  in: number;
  out: number;
  outStart: number;
  outEnd: number;
}

export function snapRanges(a: Analysis, tb: Timebase): SnappedClip[] {
  const clips: SnappedClip[] = [];
  let cursor = 0;
  for (const k of a.keep) {
    const inF = toFrames(k.start, tb);
    const outF = toFrames(k.end, tb);
    if (outF <= inF) continue;
    clips.push({ in: inF, out: outF, outStart: cursor, outEnd: cursor + (outF - inF) });
    cursor += outF - inF;
  }
  return clips;
}

function linkXml(i: number, channels: number, hasVideo: boolean): string {
  const links: string[] = [];
  if (hasVideo) {
    links.push(`<link><linkclipref>clipitem-v${i}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${i + 1}</clipindex></link>`);
  }
  for (let ch = 1; ch <= channels; ch++) {
    links.push(`<link><linkclipref>clipitem-a${ch}-${i}</linkclipref><mediatype>audio</mediatype><trackindex>${ch}</trackindex><clipindex>${i + 1}</clipindex><groupindex>1</groupindex></link>`);
  }
  return links.join("\n          ");
}

/** FCP7-style file URL (`file://localhost/C:/...`), which Premiere resolves reliably on both platforms. */
export function pathUrl(p: string): string {
  return pathToFileURL(p).href.replace(/^file:\/\/\//, "file://localhost/");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
