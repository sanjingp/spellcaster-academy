# Math fluency update — build notes

Built 2026-10-12 from `MATH-BRIEF.md`. Nothing is committed or pushed.

## Result

All five items of the brief are built in Potions, with number tiles only.
`npm test` passes on the final code: **3,773 checks, 27 scenarios, 658 s** (Chromium; WebKit is
not installed on this machine). The six new scenarios are 1,565 of those checks
(`npm test -- math`, about 3 minutes). Spelling and the saved words work as before.

Not done here: a try on a real iPad, and a run in WebKit.

## What was built

| Brief | What the child or grown-up sees |
| --- | --- |
| 1. Ten-frames | A **Dots** button under every addition fact within 20. Two ten-frames, pink dots for the first number, teal dots (with a white middle) for the second. The second number carries on where the first stops, so 8 + 5 is a full frame and 3. After a miss the fact comes back with its dots already open, in the same round and on a later day. |
| 2. Counting-on hint | A **Hint** button: "Start from the bigger number", the bigger number in a bubble, then one hop per dot of the smaller number (3 + 8: 8, then 9, 10, ?). Hops arrive one by one; with reduced motion they are all there at once. The hint is read aloud. The last hop is a "?", so the hint never shows the answer. |
| 3. Make 10 and Doubles | The Potions button now opens a **Potions menu**: Mixed potions, Make 10, Doubles. Make 10 asks "7 + ? = 10", then sums that bridge through 10 (result card: `8 + 5 = 8 + 2 + 3 = 13`). Doubles asks 6 + 6, then near doubles (card: `6 + 7 = 6 + 6 + 1 = 13`). Each has its own hint. |
| 4. Speedy brew | Offered only once every core fact of a drill is quick: on the round-complete card with "Not now", and from then on in the menu. 8 potions, no countdown, no result cards, no retries; a wrong answer gets "Almost! 8 + 5 = 13". 3 stars for joining in. The end shows the time and celebrates a personal best. |
| 5. Slow facts | Every fact answer is timed and kept under the new key `spellcaster-academy-facts-v1`, in Leitner boxes with growing waits (at once, 10 min, 1 day, 3, 7, 16 days). Slow or missed facts come back first in the drills and take the place of fresh sums in mixed rounds. The grown-ups' corner has a "Math facts" panel: the slow-facts list and **Reset math facts**. |

## Decisions I made that the brief left open

- **Quick means right within 6 seconds, without Dots or Hint.** Timed from the potion appearing to
  the Brew tap. It is one constant (`QUICK_MS` in `public/facts.js`) and a guess for Mila.
- **Three quick answers make a fact "quick".** After that a fact only climbs when it is due, so
  one long sitting cannot push it weeks away.
- **Slow costs one box and returns after 10 minutes; an answer with help goes to box 1; a miss to
  box 0.** An answer nobody could time (the iPad was put down) changes nothing.
- **A speedy brew stays once earned.** A later miss sends the fact back to practice but never
  removes the speedy brew, so it cannot feel like a penalty.
- **Only addition facts within 20 and make-10 pairs are tracked.** Taking away and story sums are
  not, and have no Dots or Hint.
- **3 + 8 and 8 + 3 are separate facts**, since starting from the bigger number is the skill.
- **"Reset stars & progress" now also clears the math facts**, and its panel says so. The new
  "Reset math facts" clears only those. Say if the first should leave the facts alone.
- **In a mixed round** a due slow or missed fact replaces a fresh sum: one per round at
  "within 100", every sum at "within 20", and only while Adding is switched on.

## Existing saves

- `spellcaster-academy-v1` keeps the same fields in the same order. Nothing is migrated.
- Opening the game writes nothing: a save from the previous version is byte-for-byte unchanged
  until something is earned (tested).
- The fact memory is a separate key. A damaged one is read as empty and never breaks the game.
- No network, no inline scripts or styles; `render.yaml` and its CSP are untouched. The new file
  `public/facts.js` is loaded by a plain `<script src>`.

## Files

- `public/facts.js` (new): the fact memory as pure functions.
- `public/potions.js`: drills, their facts, the `fact` field on addition recipes, review slots in `makeRound`.
- `public/game.js`: Potions menu, Dots and Hint, drill and speedy rounds, timing, the grown-ups' panel.
- `public/index.html`, `public/style.css`: the menu screen, helper row, speedy offer, facts panel.
- `scripts/test.mjs`: six new scenarios; older Potions scenarios now go through the menu.
- `PROGRESS.md`: updated, including known limits.

## Tests

| New scenario | Checks |
| --- | --- |
| math facts: boxes, spaced repeats and the drill recipes | 59 |
| math helpers: ten-frames and the counting-on hint on every iPad size | 1,011 |
| math drills: Make 10 and Doubles from the Potions menu | 302 |
| math speedy brew: offered only when earned, gentle and optional | 102 |
| math slow facts and their reset in the grown-ups corner | 63 |
| math update keeps a save from before it: words, stars and spelling | 28 |

To see that these can fail, I broke three things on purpose (slow facts left off the list, no
dots after a miss, the hint showing the answer). The tests caught each one; the code was then
restored and the full suite run again.

## What I looked at myself

The game was run through `npm start` (all files served with the CSP header) and through the test
browser. I looked at these screens in `screenshots/`:

- Ten-frames: 8 + 5, 12 + 5, 6 + 6, 6 + 7, 7 + ? = 10, and 3 + 8 reopened after a miss (`22-facts-dots-*`).
- Counting-on hint: 3 + 8 and 10 + 10, plus the make-10, bridge and near-double hints (`22-facts-hint-*`), on the largest and the smallest iPad size.
- Potions menu, with and without speedy brews (`23-potions-menu-*`, `26-speedy-menu-*`).
- Make 10 and Doubles rounds and their result cards (`24-drill-*`).
- Speedy brew: the offer, the round, the end card (`26-speedy-*`).
- Grown-ups' corner: the slow-facts list (`25-grownups-math-facts-portrait`) and the word list (`07-grownups-*`).
- Spelling: steps 1 to 4 and the result cards (`02-*`, `03-*`), unchanged.

Two things found and fixed on the way:

- Ten hops (10 + 10) ran past the card on the small upright iPad; hops now size to the row.
- The speedy offer pushed "Play again" off the round-complete card on the small upright iPad.
  The card's two lists now scroll first, so its buttons always stay in reach, and the offer is one
  short row after the first time.

## Known limits

- Not tried on a real iPad; Safari's voice, tap feel and timing still need a look.
- The first potion of a round is timed while the greeting is still being spoken, so it can count
  as slow a little too easily.
- A speedy brew earns its 3 stars every time, also when played many times in a row.
- On the smallest upright iPad, a round-complete card with the offer and three or more new
  rewards scrolls its lists.
