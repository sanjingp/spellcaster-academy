# Math fluency update (approved by parent)
Mila (7, almost 8) counts addition facts on her fingers. Add to Potions mode, kid-friendly, same witch world:
1. Ten-frame / dot visuals for addition facts within 20 (two ten-frames, colored dots for each addend), shown as a helper on fact problems (tap to show, or auto after a miss).
2. Counting-on strategy hint: "Start from the bigger number" - show the bigger number, then hop on the smaller one dot by dot (respect prefers-reduced-motion).
3. Make-10 drill (what goes with 7 to make 10? then bridge-through-10 like 8+5 = 8+2+3) and Doubles drill (doubles and near-doubles), selectable from the Potions menu.
4. Gentle OPTIONAL speed round: only offered once a fact set is "easy" (answered correctly and quickly several times). No harsh timer, no penalties, can always skip; celebrate personal best.
5. Slow-fact tracking with spaced repeats: record per-fact response time/accuracy in localStorage (new key, like the existing word storage); slow or missed facts come back more often (simple Leitner boxes / growing intervals across sessions). Parent screen shows the slow facts list and a reset button.
Rules: do NOT break existing spelling features, existing localStorage keys, or Mila's saved words (migrate nothing destructively). Keep CSP (no network, no inline scripts). Tile input only. Extend npm test with checks for the new math screens. Update PROGRESS.md.
