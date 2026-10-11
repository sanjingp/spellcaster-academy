# Progress

Last updated: 2026-10-10

## Status

Both modes are built. `npm test` passes: **1307 checks, 11 scenarios, about 5.5 minutes**
(Chromium; WebKit is not installed on this machine, so the suite fell back as designed).
Potions mode is in the working tree and **not committed yet**.

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
  No text field anywhere; a real keyboard's number keys, Backspace and Enter also work.
- **Topics** (each can be switched on or off):
  - Adding and Taking away — within 20 (easy) or within 100, with and without regrouping.
  - Tens and ones — count rod-and-cube blocks, "4 tens and 7 ones = ?", "How many tens are in 47?".
  - Skip counting — by 2s, 5s and 10s, one number missing.
  - Story problems — 12 short witchy stories, read aloud word for word.
  - Telling time — analog clock, on the hour (easy) or hour and half hour; answered in `h:mm` boxes.
  - Coins — labelled pennies, nickels, dimes and (within 100) quarters; answered in cents.
- **Every problem is read aloud** (rate 0.85), with "Hear it again" and "Slowly". Without speech the
  buttons are replaced by a note; everything needed is already on screen.
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
- `potions without speech, without motion, with a keyboard`.
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
- On the easy level only adding, taking away and story problems stay strictly within 20. Skip
  counting still reaches 50 by 5s and 100 by 10s, and tens-and-ones uses 10–20.
- The clock answer shows one box per digit, so it gives away whether the hour has one or two digits.
- Coins are drawn as labelled circles (1¢, 5¢, 10¢, 25¢), not as real coin faces.
- Story problems are shown as text if speech is unavailable, so a child who cannot read them yet
  will need help on a device without a voice.

## Changed outside Potions
- The home screen's single Start button became the two mode buttons (`#btn-spells`, `#btn-potions`).
- The grown-ups' corner now always opens scrolled to the top.
- The round-complete card is wider in landscape so "Play again" is always in reach.

## Orchestration log
- Codex review done (REVIEW.md, commit e1aad7a). Next: Claude fixes all 9 findings, npm test, commit, push.
