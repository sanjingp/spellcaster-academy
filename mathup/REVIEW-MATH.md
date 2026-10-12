# Independent math review — 2026-10-12

Reviewed `CLAUDE.md`, `MATH-BRIEF.md`, `mathup/build-notes.md`, the uncommitted diff, and the new implementation/support files. Findings below concern the current working tree; no application or test code was changed.

Validation: `npm test` ran in Chromium 156.0.8078.4 (WebKit is unavailable). The first 24 scenarios reported success, then the process ended with SIGTERM / exit 143 during scenario 25, the speedy-brew scenario, without an assertion failure. A separate `npm test -- math` completed successfully: **1,565 checks, all six math scenarios, 193.9 seconds**. Together the runs cover all 27 scenarios successfully, but the unfiltered run did not finish. I also inspected the math screenshots and reproduced the issues below with isolated browser probes and direct calls to the fact-memory functions. `git diff --check` passed.

1. **[P2 — save reliability / risk to subsequent word edits] A successful write to either storage key hides failures on the other.** `public/game.js:183–194`, `1625–1630`, `1654–1662`.

   `keep()` assigns the shared `storageOk` flag from the latest individual write. A normal fact answer calls `saveFacts()` and then `saveState()`: if the growing facts payload exceeds the remaining quota but the main save succeeds, the warning disappears even though the fact history was not saved. The reverse also conceals failed word edits. Browser reproduction: reject writes to `spellcaster-academy-v1`, save a changed word list, then reset math facts successfully. The old words remain in storage, but `#save-note.hidden` changes from `false` to `true`. Leaving and reopening the parent screen clears the transient word-save message as well. Reloading loses the new edits without the persistent warning that previously protected this flow.

   **Fix:** Track outstanding save failures independently for each key, and keep the warning visible until every failed key has been saved successfully. Success on the facts key must not clear a main-save failure, or vice versa. Add regression cases for each direction of partial failure; the current storage tests reject every write together and miss this case.

2. **[P2 — brief item 4 / kid UX] Speedy brews can select facts that have never become easy.** `public/game.js:1213–1216`, `1760–1764`.

   Unlocking checks the core facts, but selecting a speedy round sorts all core and stretch facts by box and takes eight without filtering for fluency. Keeping an earned speedy brew available is reasonable; including unlearned stretch facts is a separate problem. Browser reproduction: unlock Make 10 with all nine pairs in box 3, subsequently miss two pairs, and have `8+5` in box 1 after just one slow answer. The next speedy brew contains seven quick pairs plus `8+5`, despite that stretch fact never having been answered quickly. Dots and Hint are unavailable in this mode, so a struggling fact is moved into the timed activity without its support.

   **Fix:** Build the speedy question pool from facts that satisfy the fluency criterion, excluding currently missed/slow facts. If fewer than eight qualify, fill the round with spaced repetitions of eligible facts; if none qualify, offer gentle practice while preserving the earned unlock. Test selection after multiple core facts regress, including a stretch fact with only one slow/helped answer.

3. **[P2 — brief item 5 / fact-history loss] An interrupted answer erases a slow classification and postpones practice despite providing no timing evidence.** `public/facts.js:113–133`; called with `ms: NaN` at `public/game.js:1629` after the visibility handler at `2250–2253`.

   For a correct answer with invalid timing, `record()` replaces `pace` with `away` and schedules a fresh interval. Reproduction: record `12+7` correctly in 9 seconds, then answer it after a tab interruption. It disappears from both `slowList()` and mixed review even though the only measured response remains slow. An established box-5 fact answered with `ms: NaN` just before its due date has that date extended by almost another 16 days. This contradicts the build note that an unmeasurable answer changes nothing. The existing test at `scripts/test.mjs:2810` checks the box but not preservation of the due date or an existing slow classification.

   **Fix:** For an unmeasurable correct response, preserve the previous fluency classification, box, and due date; accuracy counters can be recorded separately. Do not manufacture a new interval from an interrupted attempt. Add cases starting from a slow fact and from a nearly due high-box fact, including a save/reload round trip.

4. **[P2 — brief item 5] Mixed practice abandons spaced review after one quick response, before a fact is fluent.** `public/facts.js:87`, `155–160`.

   `review()` requires `needsWork(f)`, which depends only on the last response's `pace`/`miss`. Record `12+7` as slow, then answer it quickly at its 10-minute review: it reaches box 2 and gets a one-day due date, but `isQuick()` is still false. Calling `review()` even three days later returns no such fact because its last pace is now `quick`. `12+7` belongs to neither drill, so its new due date is never used to schedule another question; it can return only by chance through fresh problem generation. The advertised growing intervals therefore stop before fluency for facts practiced through Mixed potions.

   **Fix:** Separate review eligibility from the label for the latest response. Keep due learning facts eligible until they reach the fluency threshold, and use their due dates for later maintenance reviews, while prioritizing missed/slow facts and retaining the mixed-round review cap. Test a mixed-only fact through slow → quick → next-day due → fluent across saved sessions, rather than asserting that every last-answer-quick fact is excluded.

5. **[P2 — kid UX / inaccurate slow-fact tracking] The stopwatch includes the greeting and spoken question.** `public/game.js:1238`, `1255–1257`, `1598–1600`, `2139–2146`.

   The first question's timer starts while the greeting is still playing, and the question is queued behind it. Later questions also include their own narration and any replay time. A child who listens before answering gets a different fluency assessment from a child who reads immediately. In a browser probe with controlled speech and time, five seconds of greeting/question playback followed by a 1.5-second response produced a stored time of about 6.6 seconds and `pace: 'slow'`. This affects practice scheduling and speedy unlocks, rather than just a displayed statistic. The build notes acknowledge the first-question case; the speech test stub finishes utterances too quickly to expose it.

   **Fix:** Exclude greeting/question playback from recall timing, using speech completion callbacks with a no-voice/error fallback and support for answers entered before speech finishes. Handle Hear again/Slowly consistently. Add a realistic-duration speech test that gives the same recall time to the first and subsequent questions.

6. **[P3 — progress / kid UX] Successful speedy potions never update the existing brewed total.** `public/game.js:1635–1662`, compared with the ordinary brew increment at `1685`.

   The speedy path updates `session.right`, stars, and the personal best, but never `state.math.brewed`. Browser reproduction: start with five saved potions, finish a speedy round with all eight correct, and read the save. The completion screen says “You brewed 8 of 8 speedy potions,” but `math.brewed` is still 5. Home and the parent progress display therefore omit all speedy successes, including after reload.

   **Fix:** Add the completed round's successful potions to `state.math.brewed` once in `finishSpeedy()` before saving. Counting at completion preserves the stated behavior for an abandoned speedy round. Test correct/mixed-result rounds and reload, ensuring misses are not counted and replay does not double-count a completed round.

No destructive migration or new deletion of the existing saved-word list was found. The facts use a separate key, and resetting only math facts leaves the old save untouched. Finding 1 concerns concealed failures of subsequent saves, not deletion of words already persisted. The reviewed screenshots show usable math menus, helpers, and result cards at the tested iPad sizes; real iPad Safari behavior remains unverified.
