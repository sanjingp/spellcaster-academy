// Build It: start from a base word (smile) and build the -ing word (smiling).
// The list comes from words.js -> thisWeek.build. Stars are kept in localStorage only.
(function () {
  'use strict';
  const DATA = window.SPELLCASTER_DATA || {};
  const LIST = ((DATA.thisWeek && DATA.thisWeek.build) || []).filter((b) => b && b.base && b.word);
  const KEY = 'spellcaster-build-stars';
  const $ = (id) => document.getElementById(id);
  let stars = 0;
  try { stars = Math.max(0, parseInt(localStorage.getItem(KEY), 10) || 0); } catch (e) { /* private mode */ }

  // Rounds: every word, then an extra "hope vs hop" pair at the end if both exist.
  function makeRounds() {
    const r = LIST.slice().sort(() => Math.random() - 0.5);
    const hope = LIST.find((b) => b.base === 'hope');
    const hop = LIST.find((b) => b.base === 'hop');
    if (hope && hop) r.push(Object.assign({ versus: true }, hope), Object.assign({ versus: true }, hop));
    return r;
  }
  let rounds = [], i = 0, guess = [], hints = 0, tiles = [];

  const canSpeak = 'speechSynthesis' in window;
  function say(text) {
    if (!canSpeak) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.85;
      speechSynthesis.speak(u);
    } catch (e) { /* no voice: the words are on screen anyway */ }
  }

  function hintFor(b) {
    if (b.hint) return b.hint;
    if (b.base.endsWith('e')) return `${cap(b.base)} ends in e. Drop the e, then add ing!`;
    return 'Add ing to the end!';
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function start() { rounds = makeRounds(); i = 0; $('done').hidden = true; $('card').hidden = false; show(); }

  function show() {
    const b = rounds[i];
    guess = []; hints = 0;
    const base = $('base');
    base.textContent = '';
    if (b.versus) $('rule').innerHTML = '<b>hope</b> or <b>hop</b>? Listen carefully!';
    else $('rule').innerHTML = 'Drop the <b>e</b>, then add <b>ing</b>.';
    base.textContent = b.base;
    // Tiles: the letters of the answer, shuffled, plus the dropped e as a decoy.
    const letters = b.word.split('');
    if (b.base.endsWith('e')) letters.push('e');
    tiles = letters.map((ch, k) => ({ ch, k, used: false })).sort(() => Math.random() - 0.5);
    $('msg').textContent = ''; $('msg').className = 'msg';
    render();
    say(`${b.base}. Now make ${b.word}.`);
  }

  function render() {
    const b = rounds[i];
    const slots = $('slots'); slots.textContent = '';
    for (let n = 0; n < b.word.length; n++) {
      const s = document.createElement('div');
      s.className = 'slot'; s.textContent = guess[n] ? guess[n].ch : '';
      slots.appendChild(s);
    }
    const box = $('tiles'); box.textContent = '';
    tiles.forEach((t) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'tile'; el.textContent = t.ch; el.disabled = t.used;
      el.addEventListener('click', () => { if (guess.length >= b.word.length) return; t.used = true; guess.push(t); render(); });
      box.appendChild(el);
    });
    $('stars').textContent = `⭐ ${stars}`;
  }

  function undo() { const t = guess.pop(); if (t) t.used = false; render(); }

  function hint() {
    const b = rounds[i];
    hints++;
    const m = $('msg'); m.className = 'msg try';
    if (hints === 1) {
      m.textContent = hintFor(b);
      if (b.base.endsWith('e')) $('base').innerHTML = `${b.base.slice(0, -1)}<span class="e">e</span>`;
    } else {
      // Fill the next correct letter for her.
      for (const t of guess) t.used = false;
      const want = b.word.slice(0, Math.max(1, hints - 1));
      guess = [];
      for (const ch of want) { const t = tiles.find((x) => !x.used && x.ch === ch); if (t) { t.used = true; guess.push(t); } }
      m.textContent = `It starts with “${want}”…`;
      render();
    }
    say(m.textContent);
  }

  function check() {
    const b = rounds[i];
    const g = guess.map((t) => t.ch).join('');
    const m = $('msg');
    if (g.length < b.word.length) { m.className = 'msg try'; m.textContent = 'Add more letters!'; return; }
    if (g === b.word) {
      const earned = hints === 0 ? 3 : hints === 1 ? 2 : 1;
      stars += earned;
      try { localStorage.setItem(KEY, String(stars)); } catch (e) { /* fine */ }
      m.className = 'msg good pop';
      m.textContent = `${'⭐'.repeat(earned)} Yes! ${b.base} → ${b.word}`;
      say(`Yes! ${b.word}!`);
      render();
      setTimeout(() => { i++; if (i < rounds.length) show(); else finish(); }, 1600);
    } else {
      m.className = 'msg try';
      m.textContent = 'So close! Try again, or tap 💡 Hint.';
      for (const t of guess) t.used = false; guess = []; render();
    }
  }

  function finish() {
    $('card').hidden = true; $('done').hidden = false;
    $('donemsg').textContent = `You built ${rounds.length} words! You have ${stars} stars.`;
    say('All built! Great job!');
  }

  $('hear').addEventListener('click', () => { const b = rounds[i]; say(`${b.base}. Now make ${b.word}.`); });
  $('undo').addEventListener('click', undo);
  $('hint').addEventListener('click', hint);
  $('check').addEventListener('click', check);
  $('again').addEventListener('click', start);
  if (!canSpeak) $('hear').hidden = true;
  if (!LIST.length) { $('rule').textContent = 'No Build It words this week. Add them in words.js.'; $('card').hidden = true; }
  else start();
  // Expose for tests.
  window.__build = { list: LIST };
})();
