# Math review — what was fixed

Written 2026-10-12, after `mathup/REVIEW-MATH.md` (six findings). I agree with all six and
fixed all six; none is declined. In two places I did a little more or a little less than the
review suggested, and say so under the item. Nothing is committed or pushed.

Each finding has its own test scenario, `math fix 1` to `math fix 6`
(`npm test -- "math fix"` runs the six). Results are at the end.

## The findings

### 1. A save that worked hid one that failed (P2) — fixed

- **What was wrong:** one flag for two saves. The game save (words, stars, settings) and the fact
  memory are written apart, and whichever was written last decided whether the grown-ups' notice
  showed. A word list that could not be saved lost its notice as soon as a fact answer was saved.
- **What I did** (`public/game.js`, `keep()` and `renderSaveNote()`): every key whose last write
  failed is remembered on its own. The notice shows while any is outstanding, and also while
  nothing could be kept when the game opened and nothing has been since. A write that works clears
  only its own key.
- **Not done:** the game does not write the other save again by itself when one starts working.
  The next change to it does that (the next star, setting or fact answer), and until then the
  notice stays, which is what the review asked for.
- **Test `math fix 1`:** the reviewer's steps (the word list is refused, then a reset of the math
  facts is kept: the notice stays, also after leaving and coming back, and goes only when the
  words are written), and the other way round (a fact answer is refused while the stars are kept).
  The storage stand-in in the tests can now refuse one key only.

### 2. Speedy brews could ask facts that were never quick (P2) — fixed, with a floor of four

- **What was wrong:** the round took the eight "best known" facts of the drill, whatever they
  were. After a few slips that included facts still being learned (the reviewer's 8 + 5, answered
  once, slowly), in the one mode where Dots and Hint are put away.
- **What I did** (`speedyProblems()`, `speedyReady()`, `begin()` in `public/game.js`): a speedy
  brew asks only facts that are quick right now. With fewer than eight, some come twice, never
  twice in a row. The speedy brew stays earned whatever happens.
- **Where I went a different way:** the review suggested repeats whenever fewer than eight facts
  qualify, and practice only when none do. With one, two or three quick facts that would be the
  same potion up to eight times in a row, and a "personal best" of a few seconds that no honest
  run could beat later. So below **four** quick facts the speedy button stays in the menu, says
  "A little practice first 💜", and starts a normal drill round (missed facts first, Dots and Hint
  there, the greeting says "Let's warm up with a little practice first!"). The offer on the
  round-complete card comes back as soon as four are quick again. The number is `SPEEDY_MIN`.
- **One thing more:** "quick" now also means "not slow the last time it was asked"
  (`public/facts.js`, `isQuick`). Before, a fact in a high box that had just been slow counted as
  quick and as slow at once. This changes the count on the drill card and in the grown-ups'
  summary in that one case, and the speedy brew is first earned only when no core fact was slow
  last time.
- **Test `math fix 2`:** seven quick pairs, two missed and 8 + 5 slow (the reviewer's case); four
  quick; three quick (practice first, the missed ones come with their dots, and afterwards the
  offer is back); none quick (practice, no offer, still earned).

### 3. An answer nobody could time wiped "slow" and put the fact off (P2) — fixed

- **What was wrong:** a right answer after the iPad was put down was written down as a new kind
  of answer ("away") with a fresh wait. A slow fact left the slow list; a top-box fact asked just
  before its day moved 16 days on. My build note said such an answer "changes nothing"; that was
  not true.
- **What I did** (`record()` in `public/facts.js`): for a fact that was right the last time, an
  untimed right answer now only counts (asked, right, when). Box, due day and what it was last
  time all stay. A fact that is new or was missed has nothing to keep: it goes to box 1 and comes
  back after ten minutes, when it can be timed. With the dots or the hint showing it is still
  "helped", as before.
- **Left as it was:** a right answer after more than a minute also counts as "not timed". It
  cannot be told from an iPad left lying on the table. So a fact that always takes that long is
  never listed as slow; this is in PROGRESS.md under known limits.
- **Test `math fix 3`:** a slow fact, a top-box fact an hour before its day and a day after it, a
  missed fact, each saved and loaded again; then in the game, the iPad put down in the middle of
  12 + 7 (slow) and 6 + 6 (due in an hour), a reload, and the grown-ups' list still showing
  "12 + 7 — took 9 seconds". The older check that expected "away" was changed to the new rule.

### 4. Mixed rounds dropped a fact after one quick answer (P2) — fixed

- **What was wrong:** a mixed round only reviewed facts whose last answer was slow or missed. One
  quick answer took a fact out of the review for good, long before it was quick, so a fact that
  belongs to no drill (12 + 7) never had its growing waits.
- **What I did** (`review()` in `public/facts.js`): every addition fact whose wait is over is
  reviewed: missed and slow ones first, then the others, lowest box first. The limit is unchanged
  (one a round within 100, every sum within 20, none with Adding off).
- **What follows from it:** a fact that is quick also comes back once on its day (after 3, 7,
  16 days). On the easy level with Adding as the only topic a round can be all reviews when eight
  facts are due the same day; the next round has fresh sums again.
- **Test `math fix 4`:** the box rules for slow → quick → next day → quick → three days on, and
  the same in the game over five visits with a saved fact memory (13 + 5, which the easy level
  never makes up by itself, so it can only come from the review). Also the order and the limit.
  Two older checks that had the old rule in them were changed.

### 5. The stopwatch counted the greeting and the spoken question (P2) — fixed

- **What was wrong:** the time ran from the potion appearing. The first potion of a round had the
  greeting and its own question in it (about five seconds of a six-second limit), every other one
  its question, and "Hear it again" too. A child who listens was marked slow where a child who
  reads was not. That decided what was practiced and when the speedy brew was earned.
- **What I did** (`public/game.js`: `speech.talked()` and friends, `thinkingTime()`): the voice
  adds up how long it has been busy, and the stopwatch leaves that time out. So the greeting, the
  question, "Hear it again" and "Slowly" are not thinking time, wherever they fall.
- **Why not simply start the stopwatch when the voice is done:** "Hear it again" in the middle
  would then throw away the thinking done before it, and an answer given before the voice ends
  would have no time at all. Leaving out the talking handles both: such an early answer is a very
  quick one (at least 1 ms, so it is never mistaken for "not timed").
- **Fallbacks:** without a voice, or when it fails, nothing is talking and the time runs from the
  potion appearing. If the browser never reports the end of a sentence, a longest length is
  allowed for it (1 second and 130 ms a letter at normal speed), then the stopwatch runs again.
- **Also:** a speedy brew's time leaves out its greeting the same way. The grown-ups' panel now
  says that the time the voice takes is not counted.
- **Test `math fix 5`:** a stand-in voice that takes 1.5 seconds a sentence, one after the other.
  Four seconds of thinking are four seconds on the first potion and on a later one (before the
  fix the first was 7.2 seconds and "slow"); an answer before the voice is done; Hear it again;
  Slowly; a voice that never ends; no voice; a voice that fails.

### 6. Speedy potions were not counted as brewed (P3) — fixed

- **What I did** (`finishSpeedy()` in `public/game.js`): the potions that worked are added to the
  saved count when the speedy brew is finished. Misses are not counted, and a speedy brew left in
  the middle still changes nothing.
- **Test `math fix 6`:** 5 of 8 (count 5 → 10, also after a reload), 8 of 8 (→ 18), "Play again"
  not counting twice, leaving in the middle, the home screen and the grown-ups' corner.

## What else changed

- `public/index.html`: one sentence in the grown-ups' "Math facts" panel (see 5).
- `scripts/test.mjs`: the six scenarios; the speech stand-in can take its time (`lasts`) and the
  storage stand-in can refuse one key; three older checks follow the new rules (see 3 and 4), one
  was added; two tests wait a moment before moving the clock, so they do not move it while the
  stand-in voice is talking.
- `PROGRESS.md`: the six fixes, the changed rules, known limits.
- No new storage key and no new field: `spellcaster-academy-v1` and
  `spellcaster-academy-facts-v1` have the same shape as before the fixes.

## Results

### `npm test`

Run on the final code, the whole suite in one go: **all 3,899 checks passed, 33 scenarios,
733 seconds, exit code 0** (Chromium 156; WebKit is not installed on this machine, so the suite
used Chromium as it is built to). The reviewer's full run stopped in scenario 25 with a SIGTERM
and no failed check; here the full run went through to the end.

The 33 scenarios are the 21 from before the math update (spelling, potions, both earlier
reviews), the 6 of the math update, and the 6 new ones. The full run does not print a count for
each scenario; run by themselves before it, on the same code:

| Run | Result |
| --- | --- |
| `npm test -- "math fix"` (the 6 new scenarios) | all 127 checks passed, 70 seconds |
| `npm test -- math` (those and the 6 of the math update) | all 1,693 checks passed, 267 seconds |

No `FAILED-*.png` was written by this run (the seven in `screenshots/` are from older runs).

### Do the new tests catch the bugs?

For each finding I took its fix out again in a scratch copy of the game (outside the repo) and
ran its scenario. Every one fails without its fix and passes with it:

| Scenario | Failed checks without the fix | What it reported first |
| --- | --- | --- |
| `math fix 1` | 4 | the notice went away though the word list was not saved |
| `math fix 2` | 7, then stopped early | the round ended with `8 + 5 = ?` |
| `math fix 3` | 12 | the slow fact had become "away"; a top-box fact's day had moved |
| `math fix 4` | 8 | nothing to review the next day |
| `math fix 5` | 6 | the first potion took "7196 ms" for four seconds of thinking, and was slow |
| `math fix 6` | 7 | "5 potions brewed" after a speedy brew with five brewed |

### Looked at in the running game

I started the game with `npm start` (the same files and the same Content-Security-Policy header
as on Render) and went through it at iPad size (820 × 1180, touch), with a save as the version
before the math update wrote it (six words of Mila's kind, 12 stars, an owl) and a voice that
takes 1.2 seconds a sentence. I looked at all 22 screenshots of it. (Three of them, the home
screen twice and the spellbook, were taken while the screen was still fading in; what they show
is right, and for those screens at rest I looked at the test run's pictures, see below.)

Spelling and the saved words:

- Opening the game leaves the old save as it was, byte for byte, and adds no key.
- Home shows "1 of 6 words mastered", 12 stars and the owl. The spellbook shows every saved word
  at its saved step.
- A spelling round starts with "friend" at its saved step 2 (fill in), letter tiles only, no text
  field has the focus; the spell casts, and its step is saved as 3.
- Grown-ups' corner: the word box and the list under it show the six saved words. Adding two
  ("magic, Sparkle") says "Saved 8 words"; after a reload all eight are there, and the stars
  (21 by then), the progress of "because", the robe, the owl, chimes off and the math settings
  are as they were before the reload. The save has the same nine fields as before; the fact
  memory is the only other key.

Math screens:

- Potions menu, Make 10 with its ten-frame (7 dots, 3 empty places), the hint (7, then 8, 9, 10,
  read aloud), a gentle fizzle card, Doubles with a frame for each number, a mixed round.
- Stopwatch: with 2.4 seconds of greeting and question before it, 1.5 seconds of thinking was
  saved as 1,715 ms, "quick".
- Speedy brew on a later day (one pair missed, 8 + 5 slow): it asked eight pairs that are quick
  and neither of those two; a wrong answer got "Almost! 7 + 3 = 10" and no card; the end card
  showed the potions, the time and a personal best; the potions brewed went from 8 to 15 for the
  7 that worked, on the home screen too.
- Grown-ups' "Math facts" panel: "11 facts practiced · 7 quick · 4 slow or missed", the two
  missed pairs first, then 7 + 6 (needed the dots or the hint), then 8 + 5 (took 9 seconds); the
  new sentence about the voice fits in the panel.

No page errors, no console errors or warnings, and no request to anywhere but the game itself.

Not seen in this walk: a mixed round reviewing a fact that is due (the one potion I looked at
was a fresh "76 − 31"). That is covered by `math fix 4` only.

From the test run I also looked at these eleven in `screenshots/`:

- `01-home-portrait`, `06-spellbook-portrait`, `02-play-step4-portrait`, `07-grownups-portrait`
  (home, spellbook, spelling from sound, the word list with a saved list): as before.
- `22-facts-hint-count-on-portrait` (3 + 8: start from 8, hop 9, 10, ?) and
  `22-facts-dots-make-10-first-small-ipad-landscape` (8 + 5: a full frame and 3).
- `25-grownups-math-facts-portrait` (the slow-facts panel with the new sentence).
- `27-speedy-practice-first-portrait`, `26-speedy-menu-small-ipad-portrait` and
  `26-speedy-menu-small-ipad-landscape`: the menu with "A little practice first 💜" under a
  speedy brew fits on the big upright iPad and on the two smallest sizes, nothing overlaps.
- `26-speedy-offer-small-ipad-portrait`: the offer on the round-complete card, buttons in reach.

### Not checked

- A real iPad and Safari. Everything above ran in headless Chromium with a stand-in for
  `speechSynthesis`. Two of the fixes lean on what Safari reports: whether it tells the page
  when a sentence ends (5, with a fallback if it does not) and when the page is hidden (3).
- WebKit is not installed here, so the suite did not run in it.
