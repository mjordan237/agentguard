# Demo video render pipeline

How `demo/agentguard-demo-video.mp4` was built. Not a screen recording --
the four terminal-demo pages are rendered from captured output produced by
actually running `dist/demo/*.js`; the intro, explanation, and outro are
plain-language cards grounded in those demonstrations. Every page is drawn
with `ffmpeg drawtext`, held as a timed clip, and concatenated.

## Regenerate a page image

```
node make-page.mjs <N> cue<N>.txt body<N>.txt page<N>.png
```

`cueN.txt` is the green header line(s); `bodyN.txt` is the white body
text. One drawtext filter per line (avoids an ffmpeg bug where embedded
newlines in a single multi-line textfile render a stray glyph at each
break). Canvas 1920x1080, font `/System/Library/Fonts/Supplemental/Andale
Mono.ttf`.

## Page durations (seconds) and what each page is

| Page | Duration | Content |
|---|---|---|
| 0 | 6 | Intro / what AgentGuard does |
| 1 | 9 | `legitimate-payment.js` -- ALLOW |
| 2 | 9 | `adversarial-payment.js` -- NEEDS_REVIEW (the core catch) |
| 3 | 6 | "Why it's caught" explainer |
| 4 | 9 | `unapproved-destination-payment.js` -- NEEDS_REVIEW |
| 5 | 9 | `over-limit-payment.js` -- NEEDS_REVIEW |
| 6 | 6 | Outro |

Total: 54s, well under Colosseum's 3-minute demo video cap.

## Rebuild clips + concat

```
for i in 0 1 2 3 4 5 6; do
  ffmpeg -y -loop 1 -i page$i.png -t <duration-for-page-$i> -r 30 \
    -pix_fmt yuv420p -c:v libx264 clip$i.mp4
done
printf "file 'clip0.mp4'\nfile 'clip1.mp4'\nfile 'clip2.mp4'\nfile 'clip3.mp4'\nfile 'clip4.mp4'\nfile 'clip5.mp4'\nfile 'clip6.mp4'\n" > concat-list.txt
ffmpeg -y -f concat -safe 0 -i concat-list.txt -c:v libx264 -pix_fmt yuv420p -r 30 ../agentguard-demo-video.mp4
```

Pages 1, 2, 4, and 5 come directly from running the real scripts
(`node dist/demo/legitimate-payment.js` etc.) -- don't invent or paraphrase
new output; only re-wrap or re-source it from an actual run if it needs to
change. Pages 0, 3, and 6 are concise explanation cards and must remain
grounded in demonstrated behavior.

The output is silent by design -- narration gets added separately, by a
real human voice, not synthesized. See `../demo-video-script.md` for the
narration beats and `../record-demo-video.sh` for the live-terminal
alternative if someone wants to record it instead of using this render.

## v2 (adds the Ethereum approvals scene)

`agentguard-demo-video-v2.mp4` (83 s) is built by `build-v2.mjs` from a fresh
run of the demo scripts, including `dist/demo/evm-approvals.js`:

```
for d in legitimate-payment adversarial-payment unapproved-destination-payment over-limit-payment evm-approvals; do
  node dist/demo/$d.js > run/$d.txt; done
node build-v2.mjs run out     # needs an ffmpeg with drawtext and libx264
```

Terminal pages are the captured output, only line-wrapped. Still silent;
narration is a human voice (see `../demo-video-script.md`).

## v3: animated, built from the real running product

`agentguard-demo-video-v3-animated.mp4` (110 s, 1920x1080, 30 fps, silent, captioned).

1. `dist/demo/live-flow.js` starts the real server with one customer, one named reviewer and a stand-in
   relayer that returns a fake signature (no network).
2. `capture.mjs` sends four transactions through the real API, drives the real review page in a browser
   (types the reviewer token, clicks Approve), retries the held payment, then retries it again to show
   the single-use refusal. It writes `data.json` and three screenshots.
3. `render-anim.mjs` renders `anim/index.html` frame by frame (every frame is `render(t)`) and encodes it.
   Terminal-style values on screen come from `data.json` and `dist/demo/evm-approvals.js`; the only edits
   are shortening the 78-digit maximum and two example addresses on the Ethereum card, labelled as such.

```
npm ci && npx tsc -p .
PLAYWRIGHT_DIR=<dir with node_modules/playwright> CHROME_PATH=<chromium> node demo/video-render/capture.mjs out/capture
node dist/demo/evm-approvals.js > out/evm-approvals.txt
FFMPEG=<ffmpeg with libx264> PLAYWRIGHT_DIR=... CHROME_PATH=... \
  node demo/video-render/render-anim.mjs out/capture out/evm-approvals.txt out/render 30 110
# then, for players that mishandle full-range colour:
ffmpeg -framerate 30 -i out/render/frames/%05d.jpg -vf "scale=in_range=pc:out_range=tv,format=yuv420p" \
  -c:v libx264 -crf 18 -color_range tv -movflags +faststart agentguard-demo-video-v3-animated.mp4
```

Note: run this from a copy outside iCloud-synced folders (e.g. under `~/Documents`); reading
`node_modules` there times out and stalls tsc and node.
