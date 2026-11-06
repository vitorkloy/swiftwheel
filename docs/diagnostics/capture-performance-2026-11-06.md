# Capture renderer performance — 2026-11-06

## Verdict

Drawing improved measurably. Selection creates far less React work but still has a presentation bottleneck; do not describe the entire lag report as solved.

On the unlocked Windows desktop, with the production Electron 28.3.3 build, 2966 × 900 virtual desktop, DPR 1, i5-12400F (12 logical CPUs):

| Gesture | Before median frame interval | After median frame interval | Before median p95 | After median p95 |
| --- | ---: | ---: | ---: | ---: |
| Resize selection | 33.3 ms | 33.2 ms | 50.1 ms | 49.9 ms |
| Pen | 33.3 ms | 16.7 ms | 50.0 ms | 16.8 ms |
| Rectangle | 33.3 ms | 16.7 ms | 50.1 ms | 16.8 ms |

Five trials per gesture and version, 119 frame intervals per trial (595 per group). Pen and rectangle after: zero intervals above 25 ms. Before: pen 410/595, rectangle 420/595. Median selection is effectively unchanged; its missed intervals fell from 413/595 to 310/595, but runs were sequential, not alternating, so this is not a controlled proof of selection improvement. Full per-run counts/ranges are in [before.json](capture-performance-2026-11-06/before.json) and [after.json](capture-performance-2026-11-06/after.json).

These are renderer requestAnimationFrame intervals during real application handlers, not measured physical mouse-to-screen latency or DWM presentation timestamps. The driver supplies four synthetic PointerEvents per animation frame; it does not simulate OS keys. Each trial ends with pointerup and leaves the actual committed mark in the document. Subsequent drawing trials therefore include a growing history. Screenshots were inspected to confirm selection, ink and a nonblack frozen desktop. Screenshots are private local artifacts, not committed.

## Findings and change

- Input was **already** rAF-throttled. The frozen bitmap was already an independent `<img>` and was not drawn again through canvas per move. No computed CSS filter/backdrop-filter was active; DPR was 1, not accidental supersampling.
- The pointer path still updated React selection/draft state once per frame. Each drawing frame cleared a full 2966 × 900 canvas and replayed every previous mark. Five-rectangle history: 1190 stroke calls per 120-update trial. The fix separates committed ink from transient ink, updates transient geometry directly in rAF, clears only the previous draft's dirty rectangle and commits React state at pointerup. The equivalent trial now invokes 130 strokes (120 drafts + committed history).
- React commits during a 120-update trial fall from 121 to 1–2. Pen clear area falls from 317,658,600 to 11,996,752 pixels; rectangle to 12,401,957. Frozen image, committed ink, active draft and selection/scrim are independent layers. Selection clipping no longer replays marks, and its borders/scrim use composited thin strips.
- A separate trace (not used for the frame-time table) exposed a remaining GPU presentation wait: `DirectCompositionChildSurfaceWin::PresentSwapChain`, 300 calls, 7915 ms total (~26.4 ms/call), max 61.7 ms. Renderer functions were mostly below 3 ms. This explains why eliminating React commits did not fix selection cadence; it does **not** establish the cause inside the driver/DWM.
- A `--disable-direct-composition` experiment and later bright-viewport experiment were rejected. Their apparently ideal 16.7 ms results occurred after the desktop locked (LogonUI; black BitBlt image). Those numbers are invalid for this task. No global GPU switch or alternate bright-viewport renderer ships in this change.

## Verification and remaining work

Typecheck/build and screenshots of the unlocked desktop confirmed the drawing path, actual committed pen/rectangle marks and selection borders. Export uses the unchanged mark model and original frozen image. Session transitions cancel queued pointer input; pointer cancellation commits through the normal finish path.

The desktop subsequently locked. The guarded alternating A/B run stopped rather than measuring the lock screen. The five cold-launch frame recordings must also wait for an unlocked desktop. Do not count black/locked-screen runs as verification. The existing opacity-0 startup protection is unchanged.

Local diagnostics and profiling tools live in `%TEMP%\vor-perf`. They contain no key injection. Open via `VorCaptureTestHook` (WM_APP+1); close via WM_APP+2. The old `%TEMP%\vorz` directory is obsolete.
