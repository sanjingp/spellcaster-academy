# Progress

Last updated: 2026-10-11

## Status

Both modes are built, and all 9 findings of the independent review (`REVIEW.md`) are fixed,
including the part of finding 2 that the second review (`REVIEW2.md`) sent back.
`npm test` passes: **2,207 checks in the last full run, 21 scenarios, about 10.5 minutes** (625 s)
(Chromium; WebKit is not installed on this machine, so the suite fell back as designed).
The first round of review fixes is committed (a549eb2). The fix for the second review is in the
working tree and **not committed yet** (`public/game.js`, `scripts/test.mjs`, this file).

## Second review (REVIEW2.md) — remaining finding fixed

The second review verified 8 of the 9 fixes and sent finding 2 back:

- **P2 a failed voice was forgotten when the voice list was refreshed — fixed.** The game kept one
  word for two things ("is there a voice?" and "did it last speak?"). So when the browser refreshed
  its voice list — empty first, then the same on-device voice again — "failed" was overwritten by
  "no voices" and then by "ok", and Peek and the note went away though nothing had been heard.
  Now `speech` keeps them apart: `available` (`ok` / `novoices` / `missing`) is all a voice-list
  change or the delayed voice check can touch, and `failed` is set by a speech error and cleared
  only when a try really starts speaking. What the screens show (`speech.status`) is worked out
  from the two. A try that fails while no voice is listed is remembered too.
  *Test `review 2 again`* (`npm test -- "review 2 again"`, about 20 seconds, 45 checks):
  - the reviewer's exact steps — step 4, `not-allowed`, Peek runs out, `voiceschanged` with an empty
    list, then with the on-device voice: Peek and the note stay, no new utterance, a retry that
    fails keeps them, a retry that plays brings Hear and Slowly back;
  - the same with a list that holds only online voices;
  - the refresh arriving while the word is still flashing, then in Potions, on the home screen and
    in the grown-ups' corner (the voice line keeps saying the voice did not work until "Test the
    voice" really plays);
  - a voice that never failed is trusted again as soon as it is back (no sticky fallback);
  - a voice lost in the middle of a word stays "failed" when it is listed again.
  Run against the code from before the fix, the scenario fails in every one of these blocks except
  the "never failed" one (which is there to catch over-correcting).
  The test stand-in for `speechSynthesis` now keeps `voiceschanged` listeners;
  `window.__setVoices(list)` swaps the voices and fires the event.

## Review findings (REVIEW.md) — all fixed

Each finding has its own scenario in `scripts/test.mjs` (`npm test -- "review 3"` runs just that
one). Every scenario was also run against the code from before the fix, where it fails.

1. **P1 remote voices — fixed.** Only voices with `localService === true` are ever used. With no
   such voice `speechSynthesis.speak` is never called (not even without a voice chosen); the word is
   shown instead. The grown-ups' corner names the on-device voice, or says why there is none.
   *Test `review 1`:* a local voice next to "better" remote ones, remote-only, an empty list, and
   voices that arrive late.
2. **P2 speech failures — fixed.** Any speech error other than `canceled`/`interrupted` (and other
   than a word the game stopped itself) puts the voice in a "failed" state: the word flashes, Peek
   and the note stay, and Hear stays for another try. Only a try that really starts speaking
   clears it; the 1.2-second voice check no longer does, and neither does a refreshed voice list
   (second review, see above).
   *Test `review 2`:* seven error kinds, before and after the voice check, a failed retry, a working retry.
   *Test `review 2 again`:* the voice list going away and coming back while the voice is failed.
3. **P2 retry gap — fixed.** A missed word keeps its place in line: nothing is put in front of it,
   so it is back after exactly three other turns (fewer only when fewer words are left).
   *Test `review 3`:* the reviewer's five-word case (was 12 turns, now 3), plus a second miss.
4. **P2 "constructor" — fixed.** Progress records live in an object without a prototype and are
   looked up as own properties, on creation, load and reset.
   *Test `review 4`:* typed in by a grown-up, climbs all four steps, survives a reload, resets.
5. **P2 no-voice layout — fixed.** Buttons that cannot work are not shown (no voice: Peek only;
   failed voice: Hear and Peek). The flashed word takes the place of the buttons and is exactly as
   tall, so the card does not grow and the tiles do not move. The note is one short line.
   The home screen's witch shrinks a little on a short upright iPad so its note fits too.
   *Test `review 5`:* six iPad sizes × three no-voice states, during and after the flash, with Cast in reach.
6. **P2 easy skip counting — fixed.** Easy rows never pass 20 by 2s, 5s or 10s; they are 3 to 5
   numbers long and ask for the next one (tens are `0, 10, ?`).
   *Test `review 6`:* 3,000 more generated rows, and a played round of skip counting only.
7. **P2 failed saves — fixed.** `saveState()` reports whether the write worked. While it does not,
   the grown-ups' corner shows a calm notice ("changes last only for this visit") and the messages
   say "for this visit only" instead of "Saved". The game keeps working in memory.
   *Test `review 7`:* full storage, a reload, storage coming back, failing mid-visit, and blocked storage.
8. **P3 long words — fixed.** The word shown is measured against its card and shrunk until it fits
   (and fitted again when the iPad is turned).
   *Test `review 8`:* three 12-letter words, to copy and to peek at, at six sizes; box and every letter.
9. **P3 hardware keyboard — fixed.** The keyboard shortcuts for letters, numbers, Backspace and
   Enter are gone. A button that has the focus still answers to Enter or Space, like any button.
   *Test `review 9`:* both modes.

## Done

### Spells (spelling) — committed in f029aad
- Four-step ladder per word (copy → fill in → unmix → spell from sound), miss = down one step and re-queued.
- On-screen letter tiles only, undo, hear again / slowly, gentle fizzle card, silly animated results.
- Stars per word, unlockable robes and familiars, spellbook, grown-ups' corner behind a 2-second hold
  (word list, spells per round, voice test, chimes, reset).
- Works without speech (the word flashes instead) and respects `prefers-reduced-motion`.

### Potions (math) — this change
- **Main menu**: two big buttons, ✨ Spells and 🧪 Potions. Either tap unlocks speech and chimes.
- **Brewing screen** (`#screen-brew`): witch with a bubbling cauldron, problem card, answer boxes,
  number tiles 0–9 (two rows of five in portrait, one row of ten in landscape), Undo and "Brew potion!".
  No text field anywhere, and no keyboard shortcuts: the tiles are the only way to answer.
- **Topics** (each can be switched on or off):
  - Adding and Taking away — within 20 (easy) or within 100, with and without regrouping.
  - Tens and ones — count rod-and-cube blocks, "4 tens and 7 ones = ?", "How many tens are in 47?".
  - Skip counting — by 2s, 5s and 10s, one number missing (easy: short rows that stop at 20).
  - Story problems — 12 short witchy stories, read aloud word for word.
  - Telling time — analog clock, on the hour (easy) or hour and half hour; answered in `h:mm` boxes.
  - Coins — labelled pennies, nickels, dimes and (within 100) quarters; answered in cents.
- **Every problem is read aloud** (rate 0.85), with "Hear it again" and "Slowly". Without an
  on-device voice the buttons are replaced by a note; everything needed is already on screen.
- **Miss and return**: a wrong answer shows "Oops! The potion fizzled", the finished sum, and
  "We'll try it again soon!"; the same problem comes back three turns later.
- **Rewards**: 2 stars for a first-try potion, 1 star after a miss. Stars, robes and familiars are the
  same ones Spells uses. 22 silly brew results (hippo in a flower crown, sloth on a scooter ...).
- **Round**: 8 different potions spread evenly over the topics that are on.
- **Grown-ups' corner**: "Potions (math)" panel with the level (Easy · within 20 / Within 100) and a
  toggle per topic, saved in localStorage under `math`. The last topic cannot be switched off.
  The progress line also shows potions brewed; reset clears that count but keeps the settings.

### Tests added to `scripts/test.mjs`
- `potions recipes` — 5,600 generated problems checked for correct answers and level ranges, plus
  round building and kid-safe wording. The solver reads the problem as shown, never the game's answer.
- `potions whole round` (portrait and landscape) — taps through a round, misses two on purpose,
  checks they return a few turns later, the stars, the unlocks and that Spells shows the same stars.
- `potions settings` — level and topic toggles, persistence across reload, a round that obeys them,
  reset, and a damaged save.
- `potions on tight screens` — the hardest pictures (longest story, six coins, 99 in blocks, 12:30)
  at six iPad sizes, including with Safari's toolbars showing.
- `potions without speech and without motion`.
- Home screen layout is now checked at every size (it was only checked at the two main sizes).
- `npm test -- potions` runs only the Potions scenarios (about 3 minutes).

## Files
- `public/potions.js` is **new**: math topics, problem generators and brew results as plain data and
  pure functions. `CLAUDE.md`'s layout line does not list it yet.
- `public/game.js`, `index.html`, `style.css`, `scripts/test.mjs` extended.

## Known issues and limits
- **Not yet tried on a real iPad.** Tests run in headless Chromium with a stand-in for
  `speechSynthesis`; Safari's voice, tap feel and layout still need a look on the device.
- A potion missed on one of the last three turns comes back sooner than three turns later, because
  there are not enough other potions left (Spells behaves the same way).
- Potions per round is fixed at 8; there is no grown-up setting for it.
- Speech uses on-device voices only. A device that offers only online voices plays silently, with
  the word flashed instead; that is on purpose (nothing leaves the iPad).
- The review fixes were checked with stand-ins for `speechSynthesis` and `localStorage`. Whether
  Safari reports `localService`, speech errors and `voiceschanged` the same way still needs a look
  on the iPad.
- While the voice counts as failed, each new word at steps 2 to 4 is flashed once at the start of
  its turn, also on the turn where the voice starts working again (the flash is not cut short).
- `screenshots/` still holds a few `FAILED-*.png` files from older runs made on purpose against
  unfixed code; the folder is not in git and a passing run does not clear them.
- On the easy level counting by 10s has a single row (`0, 10, ?`), so it comes up less often.
- The clock answer shows one box per digit, so it gives away whether the hour has one or two digits.
- Coins are drawn as labelled circles (1¢, 5¢, 10¢, 25¢), not as real coin faces.
- Story problems are shown as text if speech is unavailable, so a child who cannot read them yet
  will need help on a device without a voice.

## Changed outside Potions
- The home screen's single Start button became the two mode buttons (`#btn-spells`, `#btn-potions`).
- The grown-ups' corner now always opens scrolled to the top.
- The round-complete card is wider in landscape so "Play again" is always in reach.

## Orchestration log
- Codex review done (REVIEW.md, commit e1aad7a).
- 2026-10-11: Claude fixed all 9 findings and added a test scenario for each; `npm test` passes.
  Not committed (as asked). Next: commit, push.
- Codex re-review (REVIEW2.md): 8/9 verified; finding 2 voiceschanged transition remains. Claude fixing next.
- 2026-10-11: Claude fixed the remaining finding 2 (playback failure kept apart from voice
  availability) and added the `review 2 again` scenario; `npm test` passes, 2,207 checks.
  Not committed (as asked). Next: commit, push, third look by the reviewer if wanted.
- Codex verified finding 2 fixed (REVIEW3.md). Code complete; awaiting Render dashboard Blueprint setup by Sonny.
