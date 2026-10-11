# Spellcaster Academy

Standalone spelling game for Mila (2nd grade, almost 8), played on iPad Safari via a link.
Unrelated to any other project; do not import code or assets from elsewhere in /workspace.

## Stack and layout
- Pure static site: `public/index.html`, `public/style.css`, `public/game.js` (plus optional `public/words.js`). No build step, no frameworks, no CDN/network requests, no external fonts.
- Deployed as a Render static site with publish dir `public` (see `render.yaml`).
- Tests: `npm test` runs `scripts/test.mjs` (Playwright, WebKit preferred, else Chromium) at iPad size 820x1180 and 1180x820, writes screenshots to `screenshots/`.

## Game rules (must hold)
- Kid is a young witch; each spelling word is a spell. Success → silly, kid-safe animated result (e.g. frog in a cupcake hat).
- Input ONLY via on-screen letter tiles (min 60px tap targets). Never focus a text input during play (no iPad keyboard/autocorrect).
- Per-word ladder: 1 copy (word shown) → 2 fill missing letters → 3 unscramble (only the word's letters) → 4 spell from sound only (full alphabet tiles). Correct = up one step; word mastered after step 4. Miss = down one step (min 1) and word re-queued a few turns later in the session.
- Undo/backspace tile, "hear it again" button, gentle "the spell fizzled, try again" feedback; never harsh/red-X shaming.
- Speech: Web Speech API `speechSynthesis`, unlocked by a big Start button tap (Safari needs a user gesture). Prefer an en-US female/clear voice, rate ~0.85. Game must still work if speech is unavailable (show a note).
- Parent screen behind a simple gate (e.g. "hold for 2 seconds" or a math question): textarea to paste/type words (newline, comma or space separated), sanitize to letters/apostrophes, lowercase, dedupe; save to localStorage. "Use starter list" button. Text input allowed here only.
- Starter list: ~12 common 2nd-grade words.
- Rewards: stars per word; unlockable robe colors / familiars stored in localStorage.

## Hard constraints
- No chat, accounts, ads, analytics, cookies, network calls, or data collection. localStorage only.
- Bright, warm, polished, girl-friendly (purples, pinks, gold sparkles). Emoji/CSS/SVG art only.
- Respect `prefers-reduced-motion`. Disable double-tap zoom / text selection on tiles (`touch-action: manipulation`, `user-select:none`).
- Keep code readable; plain ES modules or a single script, no dependencies at runtime.

## Workflow
- Run `npm test` before declaring done; look at the screenshots.
- Keep `PROGRESS.md` updated with what's done and known issues.

## Potions (math) mode — added scope
- Main menu offers two modes: Spells (spelling, above) and Potions (math), same witch world.
- Potion brewing: solve 2nd-grade math by tapping big number tiles (0-9, backspace, brew). No keyboard.
- Topics: addition/subtraction within 100, place value (tens/ones), skip counting (2s,5s,10s), short word problems read aloud with speechSynthesis, telling time (hour/half hour) and coins if simple.
- Same miss-and-return logic: a missed problem returns a few turns later; gentle "the potion fizzled" feedback; silly kid-safe brew results; stars/rewards shared.
- Parent screen: choose math level (easy within 20 / within 100) and toggle topics; saved in localStorage.
- Extend `npm test` with Potions screenshots and checks.
