Independent review against CLAUDE.md, completed 2026-10-11, commit `e1aad7a`. Findings are ranked by severity: P1 = high, P2 = medium, P3 = low. Application files were not changed.

1. **P1 — Voice selection permits remote speech, violating the no-network requirement.**

   **Location:** `public/game.js:220`, `public/game.js:229`, `public/game.js:261`; privacy promise at `public/index.html:330`.

   Local voices receive only four bonus points, so a preferred remote en-US voice can beat an available local voice. With a controlled voice list containing local “Daniel” and remote “Google US English”, both the greeting and spelling word were passed to the remote voice. The API defines `localService: false` as a remote synthesis service; leaving `utter.voice` unset also permits the browser's default remote service. This contradicts both CLAUDE.md and “nothing is sent anywhere.” [Web Speech API specification](https://webaudio.github.io/web-speech-api/)

   **Suggested fix:** Restrict selection to suitable voices with `localService === true`. When none exists, use the visual fallback and do not call `speak()` with an unspecified voice. Test mixed local/remote lists and remote-only lists. Actual remote transmission was not exercised; the prohibited selection path was reproduced.

2. **P2 — Speech failures can leave sound-only spelling without a usable clue.**

   **Location:** `public/game.js:244`, `public/game.js:267`, `public/game.js:675`.

   The error handler ignores `not-allowed`, `audio-busy`, `audio-hardware`, and `network`. These are defined synthesis failure codes, including denial of speech by the browser/system. [Web Speech API specification](https://webaudio.github.io/web-speech-api/) With a listed voice and injected `not-allowed`, `audio-busy`, or `network` errors, step 4 keeps both the fallback note and Peek hidden. Even handled `synthesis-failed` briefly enables the fallback, then the scheduled 1.2-second voice check changes status back to `ok` merely because a voice remains listed. Once the initial peek expires, there is no visual clue despite speech still failing.

   **Suggested fix:** Track voice availability separately from successful playback. Keep the visual fallback available after playback errors until a deliberate retry actually succeeds; ignore only expected cancellation/interruption errors. Verify both the initial failure and the state after the delayed voice check.

3. **P2 — Correct answers repeatedly postpone a missed spelling word.**

   **Location:** `public/game.js:861`–`public/game.js:863`.

   Inserting correct words at queue index 2 pushes a missed word at index 3 backward again. Reproduction: save `cat dog sun hat run`, choose five words, miss `cat` on its first copy turn, and answer the following words correctly. The actual sequence is `cat(miss), dog, sun, hat, dog, sun, hat, dog, sun, hat, dog, sun, hat, cat`. The missed word returns after **12 intervening turns**, rather than a few. The existing spelling test checks only a minimum retry gap (`scripts/test.mjs:423`), so this passes.

   **Suggested fix:** Schedule retries using a turn deadline, or otherwise preserve their position against later successful-word insertions. Add a maximum-gap check with at least four unfinished words. Potions does not exhibit this particular problem because correct problems leave its queue.

4. **P2 — The accepted word “constructor” cannot climb the ladder or save progress.**

   **Location:** `public/game.js:106`, `public/game.js:172`–`public/game.js:174`; reset at `public/game.js:1566`.

   Progress is an ordinary object, and the lookup accepts inherited properties. A parent can save `constructor` as a valid 11-letter word. Its progress resolves to the inherited `Object` constructor instead of a progress record. Reproduced behavior: the first turn has step `undefined` and a blank instruction; a correct answer changes the step to `NaN`; the word keeps returning without mastery, while saved `progress` remains `{}`.

   **Suggested fix:** Use a null-prototype dictionary or a `Map`, and require an own, validated progress record. Apply the same representation during initial creation, loading, and reset. Cover `constructor` through the parent-entry and reload paths.

5. **P2 — The no-voice layout clips spelling controls on a small iPad viewport.**

   **Location:** `public/game.js:671`–`public/game.js:675`, `public/style.css:597`, `public/style.css:867`; scrolling is disabled at `public/style.css:38`.

   At **768×930**, start step 4 with `getVoices()` returning `[]`. After the availability check, Hear, Slowly, Peek, and the fallback note all occupy the prompt card. While the word is flashing, the bottom alphabet row is partly clipped and the action row is entirely below the viewport. After the flash ends and `magic` is entered, Cast still spans approximately **y=906–984** in a 930px viewport: only its top 24px is reachable. Hidden page overflow prevents normal scrolling to the rest of the control.

   **Suggested fix:** Make fallback controls fit the available height, including the temporary word display. Avoid retaining two ineffective listening buttons alongside Peek, and reserve enough room for the alphabet and action row while preserving 60px tap targets. Test missing speech and an empty voice list at every compact viewport, before and after Peek expires.

6. **P2 — Easy skip counting exceeds the advertised limit of 20.**

   **Location:** `public/potions.js:254`–`public/potions.js:257`; level label at `public/index.html:303`.

   Easy mode chooses steps of 2, 5, or 10, starts at one to six times that step, and asks for the fifth number. Counting by fives therefore produces answers up to 50; tens produce answers up to 100. The independent sample included `10, 15, 20, 25, ?` with answer `30`; 3,299 of 5,000 sampled easy skip problems exceeded 20. The arithmetic is correct, but the selected difficulty is not. The existing test limits easy skip-counting values only for twos.

   **Suggested fix:** Constrain every easy sequence, including its answer, to 0–20. Use shorter sequences where necessary, such as `0, 10, ?`, so counting by tens remains possible. Assert the bound for all three increments.

7. **P2 — Failed storage writes are reported to parents as successful saves.**

   **Location:** `public/game.js:162`–`public/game.js:167`, `public/game.js:1543`–`public/game.js:1547`.

   `saveState()` swallows write errors without reporting success or failure. With `Storage.setItem()` made to throw `QuotaExceededError`, saving `banana` displays “Saved 1 word. The next round will use them.” while the storage entry remains absent. The list works only for the current visit and disappears on reload. Stars and parent settings have the same silent persistence failure.

   **Suggested fix:** Return a save result and show a persistent, gentle parent-facing “changes last only for this visit” notice when storage is unavailable/full. Keep the in-memory game usable, but do not claim durable saving succeeded. Test the failed save followed by reload.

8. **P3 — Long model words overflow their card, and Peek can overflow the viewport.**

   **Location:** `public/style.css:702`–`public/style.css:709`, `public/style.css:717`–`public/style.css:718`.

   The model uses a single flex row with font sizing based on the viewport, without accounting for word length or the narrower prompt card beside the witch. At 820×1180, the accepted word `announcement` spans approximately x=254–809 while its card spans x=262–800. In the speech fallback, `commonwealth` plus Peek padding reaches x=838, beyond the 820px viewport. The model spills onto the background and its highlighted container is clipped. Existing layout assertions inspect the stage and answer slots but not model containment.

   **Suggested fix:** Fit the displayed model to the prompt card using its actual available width and character count, or place long models on a wider row. Check the bounds of both individual letters and the Peek background for accepted 12-character words in copy and fallback states.

9. **P3 — Hardware-keyboard play contradicts the explicit tile-only rule.**

   **Location:** `public/game.js:1689`–`public/game.js:1724`.

   Global key handlers accept letters/digits, Backspace, and Enter during play. A physical keyboard can therefore enter and submit answers without using the on-screen tiles. This is a requirements deviation from CLAUDE.md's “Input ONLY via on-screen letter tiles,” not an iPad software-keyboard popup: the probe confirmed entry while focus remained on `BODY`.

   **Suggested fix:** Remove direct answer-entry shortcuts from the production play path to meet the stated rule. Preserve ordinary accessible activation of the on-screen buttons.

Validation: `npm test` passed **all 1,305 checks** in Chromium 156, run in a temporary copy so repository screenshots and source files were untouched. Inspected generated Spells/Potions screenshots in portrait, landscape, and compact layouts, plus screenshots of the reproduced overflow. Independent probes checked 70,000 generated problems across both levels and all topics, with no answer mismatches; exercised retry order, special word keys, speech errors, voice selection, malformed JSON, blocked/full storage, and 60-word rounds. Ordinary tile sizing, undo, repeated letters, apostrophes, ladder increments/decrements, Potions retries, shared rewards, and reduced-motion checks passed.

No explicit application fetches, analytics, cookies, third-party assets, accounts, or data collection were found. Observed page requests loaded only the document, stylesheet, and three local scripts; this does not establish that native speech services are local, as finding 1 explains. Built-in words, stories, success scenes, and miss feedback were kid-safe and gentle. Malformed saves and blocked storage did not crash play; the misleading save confirmation is finding 7.

Safari limitation: WebKit was initially absent; a temporary browser download still could not launch because required system libraries were missing. No physical iPad was available. The start handlers call speech synchronously inside the mode-button gesture, and instrumented taps confirmed active user activation for the greeting and first prompt. Actual iOS audio unlock/playback, Safari font metrics, and keyboard dismissal after parent editing remain unverified. Speech-error and remote-voice findings above use controlled API stubs, not claims of observed physical-device behavior.
