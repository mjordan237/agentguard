// Renders one terminal-style still frame from a cue file + body file,
// one drawtext filter per line (sidesteps an ffmpeg drawtext bug where
// embedded newlines in a single multi-line textfile render a stray
// tofu-box glyph at each line break).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , pageNum, cuePath, bodyPath, outPath] = process.argv;
const FONT = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";
const W = 1920, H = 1080;
const CUE_SIZE = 44, BODY_SIZE = 30;
const CUE_Y0 = 80, CUE_LINE_H = 56;
const BODY_GAP = 50; // gap after the last cue line before body starts
const BODY_LINE_H = 42;

mkdirSync(`lines-${pageNum}`, { recursive: true });

const cueLines = readFileSync(cuePath, "utf8").split("\n");
const bodyLines = readFileSync(bodyPath, "utf8").split("\n");

const filters = [];
let y = CUE_Y0;
cueLines.forEach((line, i) => {
  const f = `lines-${pageNum}/cue-${i}.txt`;
  writeFileSync(f, line);
  filters.push(`drawtext=fontfile='${FONT}':textfile='${f}':fontcolor=#4ade80:fontsize=${CUE_SIZE}:x=80:y=${y}`);
  y += CUE_LINE_H;
});

y += BODY_GAP;
bodyLines.forEach((line, i) => {
  const f = `lines-${pageNum}/body-${i}.txt`;
  writeFileSync(f, line);
  filters.push(`drawtext=fontfile='${FONT}':textfile='${f}':fontcolor=white:fontsize=${BODY_SIZE}:x=80:y=${y}`);
  y += BODY_LINE_H;
});

const vf = filters.join(",");
execFileSync("ffmpeg", [
  "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`,
  "-vf", vf,
  "-frames:v", "1",
  "-update", "1",
  outPath
], { stdio: "inherit" });

console.log(`wrote ${outPath} (${y}px tall content, canvas ${H}px)`);
