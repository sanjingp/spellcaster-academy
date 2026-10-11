Reviewed `a549eb2` against `HEAD~1` and `REVIEW.md`: **8 of 9 fixes verified; finding 2 remains incomplete.**

| Original finding | Verified? | Evidence |
| --- | --- | --- |
| 1. Remote speech (P1) | Yes | Mixed lists select a local English voice; remote-only lists never call `speak()`. |
| 2. Speech failures lose fallback (P2) | No — partial fix | Errors survive the delayed check, but a voice-list refresh still removes the fallback; see below. |
| 3. Missed-word postponement (P2) | Yes | Original reproduction passes; 6,000 independent queue simulations never exceeded three intervening turns. |
| 4. `constructor` progress (P2) | Yes | Parent entry, all four steps, persistence, reload, and reset pass. |
| 5. Compact no-voice layout (P2) | Yes | Six viewport sizes pass missing/empty/failed-speech checks; Cast remains reachable during and after Peek. |
| 6. Easy skip counting (P2) | Yes | 30,000 independently sampled sequences by 2/5/10 stayed within 0–20, including answers. |
| 7. Misleading save confirmation (P2) | Yes | Failed writes show the temporary-visit notice; reload and storage recovery behave correctly. |
| 8. Long model/Peek overflow (P3) | Yes | Twelve-character models fit across six sizes, including Peek and rotation. |
| 9. Hardware-keyboard answers (P3) | Yes | Direct answer shortcuts are removed in both modes; focused buttons retain normal activation. |

**P2 — Preserve playback failure across voice-list refreshes (remaining finding 2).** `public/game.js:285`: an empty list overwrites `failed` with `novoices`; restoring the local voice then sets `ok` without successful playback. Reproduced at step 4 with injected `not-allowed`: after Peek expires, dispatch `voiceschanged` with an empty list, then with the original local voice. Both Peek and the fallback note disappear, with no new utterance or successful playback. Keep playback failure separate from voice availability and cover this transition in tests.

No additional new P1/P2 regressions found.

Validation: `npm test` passed **all 2,161 checks** in Chromium 156, run from a temporary copy. Inspected generated screenshots and ran independent speech, persistence, keyboard, layout, queue, and arithmetic probes. WebKit was unavailable; physical iPad audio remains unverified. Only `REVIEW2.md` was changed in the repository.
