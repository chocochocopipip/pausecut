import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, findGaps, classifyGaps, buildKeepRanges, buildMarkers, timebaseFor, framesToTimecode, toFrames } from "../dist/index.js";

const cfg = mergeConfig();

test("findGaps includes leading/trailing edges", () => {
  const gaps = findGaps([{ start: 1, end: 5 }, { start: 6, end: 9 }], 10);
  assert.deepEqual(gaps, [
    { start: 0, end: 1, edge: true },
    { start: 5, end: 6, edge: false },
    { start: 9, end: 10, edge: true },
  ]);
});

test("tier decisions without motion", () => {
  const gaps = classifyGaps([
    { start: 10, end: 10.2, edge: false }, // micro
    { start: 20, end: 20.5, edge: false }, // cut
    { start: 30, end: 32, edge: false }, // squeeze
    { start: 40, end: 46, edge: false }, // long → marker
  ], { ...cfg, motion: { ...cfg.motion, enabled: false } });
  assert.deepEqual(gaps.map((g) => g.action), ["keep", "cut", "squeeze", "marker"]);
  // cut keeps padding on both sides
  assert.deepEqual(gaps[1].removed, [{ start: 20.08, end: 20.42 }]);
  // squeeze keeps squeezeTo/2 on each side
  assert.deepEqual(gaps[2].removed, [{ start: 30.3, end: 31.7 }]);
  assert.equal(gaps[2].saved, 1.4);
});

test("motion promotes still gaps and protects active gaps", () => {
  const gaps = classifyGaps([
    { start: 30, end: 32, edge: false, motion: 0.5 }, // squeeze + still → cut
    { start: 40, end: 42, edge: false, motion: 9 }, // squeeze + active → keep
    { start: 50, end: 56, edge: false, motion: 0.5 }, // long + still → squeeze
    { start: 60, end: 66, edge: false, motion: 9 }, // long + active → marker
  ], cfg);
  assert.deepEqual(gaps.map((g) => g.action), ["cut", "keep", "squeeze", "marker"]);
});

test("keep ranges are contiguous in output and markers map to output time", () => {
  const gaps = classifyGaps([
    { start: 0, end: 2, edge: true },
    { start: 10, end: 10.8, edge: false },
    { start: 20, end: 26, edge: false, motion: 9 },
    { start: 30, end: 33, edge: true },
  ], cfg);
  const keep = buildKeepRanges(gaps, 33);
  let cursor = 0;
  for (const k of keep) {
    assert.equal(k.outStart, cursor);
    cursor = Math.round((cursor + (k.end - k.start)) * 1000) / 1000;
  }
  assert.equal(keep[0].start, 2 - cfg.tiers.padAfter);
  const markers = buildMarkers(gaps, keep);
  assert.equal(markers.length, 1);
  // 20s in source, minus (2-0.08) lead and (0.8-0.16) cut
  assert.equal(markers[0].time, Math.round((20 - (2 - 0.08) - (0.8 - 0.16)) * 1000) / 1000);
});

test("timebase detection and timecode", () => {
  assert.deepEqual(timebaseFor(29.97), { timebase: 30, ntsc: true, fps: 29.97 });
  assert.deepEqual(timebaseFor(25), { timebase: 25, ntsc: false, fps: 25 });
  assert.deepEqual(timebaseFor(23.976), { timebase: 24, ntsc: true, fps: 23.976 });
  const tb = timebaseFor(30);
  assert.equal(framesToTimecode(toFrames(61.5, tb), tb), "00:01:01:15");
});
