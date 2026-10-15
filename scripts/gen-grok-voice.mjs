// Pre-generate Grok voice MP3s for this week's words and sentences (run on a computer, NOT in the browser).
//   XAI_API_KEY=... node scripts/gen-grok-voice.mjs
// Writes public/audio/<word>.mp3 and public/audio/<word>-sentence.mp3. The key never ships to the site.
import fs from 'node:fs';
import vm from 'node:vm';
const key = process.env.XAI_API_KEY;
if (!key) { console.error('Set XAI_API_KEY first.'); process.exit(1); }
const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync('public/words.js', 'utf8'), ctx);
const tw = ctx.window.SPELLCASTER_DATA.thisWeek;
fs.mkdirSync('public/audio', { recursive: true });
async function tts(text, file) {
  const r = await fetch('https://api.x.ai/v1/tts', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: process.env.GROK_VOICE || 'luna', language: 'en' }) });
  if (!r.ok) throw new Error(`${file}: ${r.status} ${await r.text()}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); console.log('wrote', file);
}
for (const w of tw.words) {
  await tts(w, `public/audio/${w}.mp3`);
  if (tw.sentences[w]) await tts(tw.sentences[w], `public/audio/${w}-sentence.mp3`);
}
