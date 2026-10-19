# pausecut

Voice-activity based pause removal for talk-heavy video: commentary, podcasts, gameplay with narration.

It finds the gaps **between speech** using [Silero VAD](https://github.com/snakers4/silero-vad) (not a dB threshold, so card shuffles, mouse clicks and game audio don't count as "speech"), classifies each gap into tiers, optionally checks whether anything is moving on screen during the gap, and then hands you a cut list as:

- **Premiere Pro XML** (FCP7 xmeml) — File › Import, and you get a sequence with every cut already made plus markers on the long pauses it left for you
- **EDL** (CMX3600)
- **JSON / CSV** report of every gap and the decision taken (the JSON is also what the `export` command and any MCP/agent workflow consumes)
- or a **direct ffmpeg render** for a quick preview

日本語の説明は[下](#日本語)にあります。

## Install

```sh
npm install -g pausecut
```

Requires Node 18+ and `ffmpeg`/`ffprobe` on your PATH (or set `PAUSECUT_FFMPEG` / `PAUSECUT_FFPROBE`). The Silero model ships inside the package; nothing is downloaded at runtime. Runs on CPU at roughly 20× realtime.

## Quick start

```sh
# Analyze, write JSON + CSV + Premiere XML + EDL next to the file
pausecut episode.mp4 --all

# Gameplay commentary preset, and render a preview to check the feel
pausecut episode.mp4 --preset gameplay --xml --render episode_preview.mp4

# Tune by hand
pausecut episode.mp4 --xml --cut-min 0.25 --squeeze-min 0.8 --squeeze-to 0.5 --pad 0.06
```

Then in Premiere Pro: **File › Import** the `.xml`. If Premiere can't find the media (because you analyzed on another machine), pass `--source-path` with the path as Premiere will see it, or just relink when asked.

## Review UI

```sh
pausecut review episode.mp4 --preset gameplay
```

Opens a local page (127.0.0.1 only) where you can:

- see every candidate pause in a list — click one and it plays from 1.5 s before to 1.5 s after
- switch between **original** and **cut preview** playback (the preview skips the removed ranges live, no render needed)
- override any candidate: keep / cut / squeeze / marker (keys `1`–`4`, `0` clears the override)
- move every threshold with sliders — VAD sensitivity, tier lengths, padding, motion threshold — and watch the list and the timeline re-decide instantly (VAD and motion are computed once at startup; thresholds are applied in memory)
- export XML / EDL / CSV / JSON or render with ffmpeg, with progress, from the **書き出す** button

Overrides survive threshold changes (they're keyed by the gap's time range). If the source isn't something a browser can play (ProRes, MKV with odd codecs, …) a 720p proxy is made once and cached in the temp folder; the exports still point at the original file.

## How it decides

Every gap between two speech segments gets a tier from its length:

| gap length                      | tier    | action                                                                      |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| `< cutMin` (0.3 s)              | micro   | keep — natural speech rhythm                                                |
| `cutMin … squeezeMin` (0.3–1 s) | cut     | remove, keeping `padBefore`/`padAfter` (0.08 s) around the speech           |
| `squeezeMin … markerMin` (1–4 s)| squeeze | shorten to `squeezeTo` (0.6 s): one jump cut in the middle of the gap       |
| `≥ markerMin` (4 s)             | long    | keep and drop a **sequence marker** so you can decide                       |

Leading and trailing silence is trimmed to the padding.

### On-screen motion

When the input has video and motion analysis is on (default), each gap also gets a motion score — the mean frame-to-frame pixel difference on a 96-px-wide grayscale downscale, sampled at 4 fps. A static game board scores ≈0–1, a hand moving cards 3–10, a scene change 30+. Gaps below `--still` (default 2.0) count as *still*:

| tier    | still (nothing happening) | active (something on screen) |
| ------- | ------------------------- | ---------------------------- |
| cut     | cut                       | cut                          |
| squeeze | **cut** (promoted)        | **keep** (protected)         |
| long    | **squeeze** (promoted)    | marker                       |

So a 3-second pause while you stare at a static board gets removed, but the same 3 seconds while you're physically playing a card is left alone. Turn it off with `--no-motion` for talking-head content.

### Presets

```
pausecut presets
```

| preset       | for                                                       |
| ------------ | --------------------------------------------------------- |
| `talk`       | talking head / podcast — no motion check, cut most pauses |
| `gameplay`   | commentary over a game — motion-aware (the defaults)      |
| `aggressive` | tight jump-cut style, shorter thresholds, smaller padding |
| `gentle`     | only clearly dead air, more padding                       |

Precedence: preset → `--config` file → individual flags.

## Commands

### `pausecut [analyze] <input>`

Runs VAD + motion analysis and writes outputs. Flags:

```
Tuning
  -p, --preset <name>        talk | gameplay | aggressive | gentle
  -c, --config <file>        JSON config (see `pausecut init`)
  --cut-min <sec>            gaps >= this are cut                    (0.3)
  --squeeze-min <sec>        gaps >= this are squeezed, not cut      (1.0)
  --marker-min <sec>         gaps >= this are kept and marked        (4.0)
  --squeeze-to <sec>         length a squeezed gap becomes           (0.6)
  --pad <sec>                silence kept on both sides of a cut     (0.08)
  --pad-before / --pad-after set the two sides separately
  --threshold <0-1>          VAD speech probability                  (0.5)
  --min-speech <sec>         drop speech bursts shorter than this    (0.25)
  --min-silence <sec>        bridge silences shorter than this       (0.1)
  --no-motion                skip on-screen motion analysis
  --still <value>            motion score below which a gap is still (2.0)
  --start / --end <sec>      analyze only part of the file

Outputs (written next to the input, or to --out-dir)
  --all                      --csv --xml --edl
  --csv                      per-gap decision table
  --xml                      Premiere Pro / FCP7 XML sequence
  --edl                      CMX3600 EDL
  --render <file>            render the cut with ffmpeg (x264/aac; --crf, --encode-preset)
  --no-json                  skip the analysis JSON
  --source-path <path>       media path as Premiere will see it (for the XML)
  --name <name>              sequence name
  -d, --out-dir <dir>
  -q, --quiet
```

### `pausecut export <file.pausecut.json>`

Re-exports XML/EDL/CSV/render from a saved analysis without re-running VAD. Useful when you edit the JSON by hand — change any gap's `"action"` to `keep` / `cut` / `squeeze` / `marker` and its `"removed"` ranges, then export again. (`removed` is what actually drives the cut; `action` is the label.)

### `pausecut init [--preset name]`

Writes `pausecut.config.json` with every setting, to edit and pass with `--config`.

## Output JSON

`<name>.pausecut.json` contains everything, so other tools (or an agent driving Premiere through an MCP server) can act on it without re-analysis:

```jsonc
{
  "source": { "path": "...", "duration": 1834.2, "fps": 29.97, "width": 1920, "height": 1080, ... },
  "config": { ...effective config... },
  "speech": [ { "start": 1.5, "end": 6.6 }, ... ],
  "gaps": [
    { "index": 3, "start": 13.63, "end": 15.84, "duration": 2.21,
      "tier": "squeeze", "motion": 0.1, "motionLevel": "still",
      "action": "cut", "removed": [ { "start": 13.71, "end": 15.76 } ], "saved": 2.05,
      "reason": "squeeze tier, no on-screen motion → cut" }
  ],
  "keep":    [ { "start": 1.39, "end": 6.48, "outStart": 0 }, ... ],   // source ranges, in order, with their output position
  "markers": [ { "time": 31.8, "sourceTime": 41.47, "duration": 6.2, "label": "pause 6.2s (active)" } ],
  "stats":   { "sourceDuration": 57.85, "outputDuration": 44.55, "removed": 13.3, "removedPercent": 23, ... }
}
```

`keep` is the simplest thing to act on: play these source ranges back to back. `gaps[].removed` is the same information as deletions, in source time, which maps directly onto "razor at `start`, razor at `end`, ripple delete" in an NLE.

## Library use

```ts
import { analyze, toXmeml, render } from "pausecut";

const a = await analyze("episode.mp4", { config: { tiers: { squeezeTo: 0.5 } } });
await fs.writeFile("episode.xml", toXmeml(a));
await render(a, { output: "episode_cut.mp4" });
```

## Notes

- Everything is frame-snapped to the source frame rate in the XML/EDL; the JSON keeps millisecond precision.
- Stereo sources become A1/A2 in the sequence; mono becomes A1. Multichannel beyond 2 is mapped to the first two.
- Speech detection is language-independent (Silero is trained on 100+ languages).
- `onnxruntime-node` ships prebuilt CPU binaries for macOS (x64/arm64), Windows x64 and Linux x64/arm64. Its postinstall also tries to fetch optional GPU providers; if your network blocks that, `npm install -g --ignore-scripts pausecut` is fine.

## 日本語

喋りの「間」を Silero VAD（音声区間検出）で見つけて、Premiere Pro 用の XML（カット済みシーケンス＋長い間にマーカー）、EDL、JSON/CSV のカットリスト、または ffmpeg での直接書き出しを出力する CLI です。音量ではなく「声があるか」で判定するので、カードを切る音やクリック音、ゲーム音は無視されます。

```sh
npm install -g pausecut          # Node 18+ と ffmpeg が必要
pausecut 動画.mp4 --preset gameplay --all
```

できた `動画.pausecut.xml` を Premiere で **ファイル › 読み込み** すると、カット済みのシーケンスが入ります。

間の長さで 3 段階に扱いが変わります（数値はすべて変更可）。

- 0.3〜1.0 秒 → 前後 0.08 秒を残してカット
- 1.0〜4.0 秒 → 0.6 秒に詰める（間の真ん中で 1 回ジャンプカット）
- 4.0 秒以上 → 残してシーケンスマーカーを打つ（手動で判断）

さらに動画がある場合は、間の中で画面が動いているかを見て判定を変えます。画面が止まっていれば（＝本当のデッドタイム）1 段階強くカットし、動いていれば（＝プレイ中）1.0〜4.0 秒の間は残します。しきい値は `--still`、無効化は `--no-motion` です。

ブラウザで候補を確認しながら調整するには:

```sh
pausecut review 動画.mp4 --preset gameplay
```

候補一覧をクリックするとその前後が再生され、「カット後プレビュー」に切り替えると削除区間を飛ばして再生します。各候補は 残す／カット／詰める／マーカー に手で変更でき（キー `1`〜`4`、`0` で解除）、左のスライダーで声の判定感度や各段階の秒数、画面の動きのしきい値を動かすと一覧とタイムラインが即座に再計算されます。右下の「書き出す」から XML / EDL / CSV / JSON の保存と ffmpeg での書き出しができます。

よく使うオプション: `--cut-min` `--squeeze-min` `--marker-min` `--squeeze-to` `--pad` `--threshold` `--still`。`pausecut presets` でプリセット一覧、`pausecut init` で設定ファイルの雛形が出ます。JSON を手で直して `pausecut export 動画.pausecut.json --xml` で再出力もできます。

## License

MIT
