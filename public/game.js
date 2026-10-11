// Spellcaster Academy — a spelling game where every word is a spell.
// Single plain script, no dependencies, no network. Data lives in words.js.
(() => {
  'use strict';

  const DATA = window.SPELLCASTER_DATA;
  const STORE_KEY = 'spellcaster-academy-v1';

  const MIN_LEN = 2;
  const MAX_LEN = 12;
  const MAX_WORDS = 60;
  const FREE_MAX = MAX_LEN + 2; // most letters allowed when spelling from sound
  const LAST_STEP = 4;
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const VOWELS = 'aeiou'.split('');

  const WORD_RATE = 0.85;
  const SLOW_RATE = 0.55;
  const PEEK_MS = 2600;

  const STEP_TITLES = {
    1: 'Copy the spell',
    2: 'Fill in the missing letters',
    3: 'Unmix the letters',
    4: 'Listen and spell',
  };

  // ------------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const calm = () => !!(motionQuery && motionQuery.matches);

  // ------------------------------------------------------------------
  // Word lists
  // ------------------------------------------------------------------
  // Turns whatever a grown-up typed into a clean list: letters and
  // apostrophes only, lowercase, no repeats.
  function sanitizeWords(text) {
    const words = [];
    const skipped = [];
    const seen = new Set();
    const pieces = String(text || '')
      .replace(/[‘’ʼ`´]/g, "'")
      .split(/[\s,;]+/);
    for (const piece of pieces) {
      if (!piece) continue;
      const word = piece
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z']/g, '')
        .replace(/'{2,}/g, "'")
        .replace(/^'+|'+$/g, '');
      if (word.length < MIN_LEN || word.length > MAX_LEN) {
        skipped.push(piece);
      } else if (!seen.has(word) && words.length < MAX_WORDS) {
        seen.add(word);
        words.push(word);
      }
    }
    return { words, skipped };
  }

  // ------------------------------------------------------------------
  // Saved state (localStorage only)
  // ------------------------------------------------------------------
  function freshState() {
    return {
      words: DATA.starterWords.slice(),
      custom: false,
      roundSize: 5, // 0 means "all words"
      progress: {}, // word -> { step, mastered, best, last }
      stars: 0,
      robe: DATA.robes[0].id,
      familiar: DATA.familiars[0].id,
      chimes: true,
    };
  }

  function loadState() {
    const state = freshState();
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        const { words } = sanitizeWords(Array.isArray(saved.words) ? saved.words.join(' ') : '');
        if (words.length) {
          state.words = words;
          state.custom = !!saved.custom;
        }
        if ([0, 3, 5, 8].includes(saved.roundSize)) state.roundSize = saved.roundSize;
        if (Number.isFinite(saved.stars) && saved.stars >= 0) state.stars = Math.floor(saved.stars);
        if (saved.progress && typeof saved.progress === 'object') {
          for (const [word, p] of Object.entries(saved.progress)) {
            if (!p || typeof p !== 'object') continue;
            state.progress[word] = {
              step: clamp(Math.floor(p.step) || 1, 1, LAST_STEP),
              mastered: Math.max(0, Math.floor(p.mastered) || 0),
              best: clamp(Math.floor(p.best) || 0, 0, 3),
              last: Number(p.last) || 0,
            };
          }
        }
        if (typeof saved.chimes === 'boolean') state.chimes = saved.chimes;
        const robe = DATA.robes.find((r) => r.id === saved.robe);
        if (robe && robe.cost <= state.stars) state.robe = robe.id;
        const familiar = DATA.familiars.find((f) => f.id === saved.familiar);
        if (familiar && familiar.cost <= state.stars) state.familiar = familiar.id;
      }
    } catch (err) {
      // Private browsing or a damaged save: just start fresh.
    }
    return state;
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      // Storage may be full or blocked; the game still works for this visit.
    }
  }

  let state = loadState();

  function progressFor(word) {
    if (!state.progress[word]) state.progress[word] = { step: 1, mastered: 0, best: 0, last: 0 };
    return state.progress[word];
  }

  const currentRobe = () => DATA.robes.find((r) => r.id === state.robe) || DATA.robes[0];
  const currentFamiliar = () => DATA.familiars.find((f) => f.id === state.familiar) || DATA.familiars[0];

  // ------------------------------------------------------------------
  // Speech (Web Speech API). Safari only talks after a tap, so the big
  // Start button says the first sentence.
  // ------------------------------------------------------------------
  const PREFERRED_VOICES = [
    'samantha', 'ava', 'allison', 'susan', 'zoe', 'nicky', 'joelle', 'noelle', 'evan',
    'jenny', 'aria', 'michelle', 'zira', 'google us english', 'female',
  ];
  const SILLY_VOICES = [
    'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news', 'jester',
    'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'fred', 'junior', 'ralph',
    'kathy', 'eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley',
  ];

  const speech = {
    // 'ok' | 'novoices' (API there but nothing to speak with) | 'missing'
    status: 'speechSynthesis' in window && window.speechSynthesis &&
      typeof window.SpeechSynthesisUtterance === 'function' ? 'ok' : 'missing',
    voice: null,
    current: null, // keeps the utterance alive; Safari drops it mid-word otherwise
    checkTimer: 0,

    get works() { return this.status === 'ok'; },

    voices() {
      try {
        return window.speechSynthesis.getVoices() || [];
      } catch (err) {
        return [];
      }
    },

    scoreVoice(voice) {
      const lang = String(voice.lang || '').replace('_', '-').toLowerCase();
      if (!lang.startsWith('en')) return -1;
      const name = String(voice.name || '').toLowerCase();
      let score = lang === 'en-us' ? 100 : 30;
      const liked = PREFERRED_VOICES.findIndex((p) => name.includes(p));
      if (liked >= 0) score += 60 - liked;
      if (/enhanced|premium|natural/.test(name)) score += 8;
      if (voice.localService) score += 4;
      if (SILLY_VOICES.some((s) => name.startsWith(s))) score -= 90;
      return score;
    },

    pickVoice() {
      if (this.status === 'missing') return null;
      let best = null;
      let bestScore = 0;
      for (const voice of this.voices()) {
        const score = this.scoreVoice(voice);
        if (score > bestScore) {
          best = voice;
          bestScore = score;
        }
      }
      this.voice = best;
      return best;
    },

    // If the browser has the API but never offers a voice, fall back to peeking.
    checkVoices() {
      if (this.status === 'missing') return;
      const before = this.status;
      this.status = this.voices().length ? 'ok' : 'novoices';
      if (this.status === 'ok') this.pickVoice();
      if (before !== this.status) onSpeechChange();
    },

    scheduleCheck() {
      if (this.status === 'missing') return;
      clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => this.checkVoices(), 1200);
    },

    say(text, { rate = WORD_RATE, pitch = 1.1, queue = false } = {}) {
      if (this.status === 'missing') return false;
      try {
        const synth = window.speechSynthesis;
        if (!queue) synth.cancel();
        const utter = new window.SpeechSynthesisUtterance(text);
        const voice = this.voice || this.pickVoice();
        if (voice) utter.voice = voice;
        utter.lang = voice ? voice.lang : 'en-US';
        utter.rate = rate;
        utter.pitch = pitch;
        utter.volume = 1;
        utter.onerror = (event) => {
          const reason = event && event.error;
          if (reason === 'synthesis-unavailable' || reason === 'voice-unavailable' ||
              reason === 'language-unavailable' || reason === 'synthesis-failed') {
            this.status = 'novoices';
            onSpeechChange();
          }
        };
        this.current = utter;
        if (synth.paused) synth.resume();
        synth.speak(utter);
        return true;
      } catch (err) {
        this.status = 'missing';
        onSpeechChange();
        return false;
      }
    },

    hush() {
      if (this.status === 'missing') return;
      try {
        window.speechSynthesis.cancel();
      } catch (err) { /* nothing to stop */ }
    },
  };

  // ------------------------------------------------------------------
  // Little chimes (Web Audio, made on the fly — no sound files)
  // ------------------------------------------------------------------
  const chimes = {
    ctx: null,

    unlock() {
      if (!state.chimes) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!this.ctx) this.ctx = new AudioCtx();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (err) {
        this.ctx = null;
      }
    },

    note(freq, delay, length, volume = 0.06, type = 'triangle') {
      if (!state.chimes || !this.ctx || this.ctx.state !== 'running') return;
      try {
        const start = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + length + 0.05);
      } catch (err) { /* chimes are optional */ }
    },

    tap() { this.note(740, 0, 0.09, 0.04); },
    undo() { this.note(392, 0, 0.1, 0.04); },
    success() { [523, 659, 784, 1047].forEach((f, i) => this.note(f, i * 0.08, 0.3)); },
    mastered() { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.note(f, i * 0.09, 0.42)); },
    fizzle() { [440, 370, 311].forEach((f, i) => this.note(f, i * 0.13, 0.3, 0.035, 'sine')); },
  };

  // ------------------------------------------------------------------
  // Art: the little witch (inline SVG so robe colors can change)
  // ------------------------------------------------------------------
  function starPath(cx, cy, outer, inner = outer * 0.46) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? inner : outer;
      const a = (Math.PI * i) / 5 - Math.PI / 2;
      d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
    }
    return `${d}Z`;
  }

  let witchCount = 0;

  function witchSVG(robe) {
    const id = `robe-fill-${++witchCount}`;
    const main = robe.rainbow ? `url(#${id})` : robe.main;
    const { dark, trim } = robe;
    const skin = '#f7cfa8';
    const hair = '#5b3523';
    const ink = '#2f1a4d';
    const gradient = robe.rainbow
      ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">${robe.rainbow
        .map((c, i) => `<stop offset="${Math.round((i / (robe.rainbow.length - 1)) * 100)}%" stop-color="${c}"/>`)
        .join('')}</linearGradient></defs>`
      : '';
    return `
<svg class="witch-svg" viewBox="0 0 240 280" role="img" aria-label="A young witch with a wand">
  ${gradient}
  <ellipse cx="120" cy="270" rx="66" ry="8" fill="rgba(40,10,80,.22)"/>
  <g class="witch-body">
    <path d="M88 110C60 122 44 160 58 194c6 9 18 7 20-4-6-28 4-48 18-60z" fill="${hair}"/>
    <path d="M152 110c28 12 44 50 30 84-6 9-18 7-20-4 6-28-4-48-18-60z" fill="${hair}"/>
    <circle cx="66" cy="182" r="7" fill="${trim}"/>
    <circle cx="174" cy="182" r="7" fill="${trim}"/>
    <ellipse cx="100" cy="262" rx="17" ry="8" fill="#3b2166"/>
    <ellipse cx="140" cy="262" rx="17" ry="8" fill="#3b2166"/>
    <path d="M88 150c12-6 52-6 64 0l28 100c-30 12-90 12-120 0z" fill="${main}"/>
    <path d="M60 250c30 12 90 12 120 0" fill="none" stroke="${trim}" stroke-width="6" stroke-linecap="round"/>
    <path d="${starPath(102, 214, 9)}" fill="${trim}"/>
    <path d="${starPath(140, 196, 6.5)}" fill="${trim}" opacity=".9"/>
    <path d="${starPath(132, 232, 5)}" fill="${trim}" opacity=".8"/>
    <path d="M90 154c-20 10-32 32-32 54l22 4c0-18 10-34 24-42z" fill="${dark}"/>
    <circle cx="68" cy="213" r="10" fill="${skin}"/>
    <g class="wand-arm">
      <path d="M150 152c20 2 36-10 48-28l-16-14c-8 16-22 26-42 30z" fill="${dark}"/>
      <path d="M192 116l22-46" stroke="#8a5a34" stroke-width="5" stroke-linecap="round"/>
      <circle cx="192" cy="116" r="10" fill="${skin}"/>
      <path class="wand-star" d="${starPath(216, 62, 15)}" fill="#ffd75e" stroke="#fff6c9" stroke-width="2" stroke-linejoin="round"/>
    </g>
    <path d="M98 150q22 20 44 0-22-6-44 0z" fill="${trim}"/>
    <circle cx="120" cy="106" r="40" fill="${skin}"/>
    <path d="M80 110c-2-30 20-46 40-46s42 16 40 46c-6-16-18-24-30-24-6 8-20 8-30 2-10 2-16 10-20 22z" fill="${hair}"/>
    <g class="witch-eyes">
      <ellipse cx="106" cy="113" rx="5.5" ry="7.5" fill="${ink}"/>
      <ellipse cx="134" cy="113" rx="5.5" ry="7.5" fill="${ink}"/>
      <circle cx="108" cy="110" r="2.2" fill="#fff"/>
      <circle cx="136" cy="110" r="2.2" fill="#fff"/>
    </g>
    <ellipse cx="94" cy="125" rx="8" ry="5" fill="#ff8fb3" opacity=".55"/>
    <ellipse cx="146" cy="125" rx="8" ry="5" fill="#ff8fb3" opacity=".55"/>
    <path d="M110 127q10 10 20 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>
    <g transform="rotate(-7 120 76)">
      <ellipse cx="120" cy="77" rx="66" ry="13" fill="${dark}"/>
      <path d="M82 76c10-30 30-58 68-70 14-4 22 4 22 14-12-4-22 4-22 16 2 16 6 28 10 40-24 10-54 10-78 0z" fill="${main}"/>
      <path d="M85 66q36 13 73 0l3 10q-39 14-79 0z" fill="${trim}"/>
      <path d="${starPath(126, 42, 8)}" fill="${trim}"/>
    </g>
  </g>
</svg>`;
  }

  function renderCasters() {
    const robe = currentRobe();
    const familiar = currentFamiliar();
    for (const box of $$('[data-witch]')) box.innerHTML = witchSVG(robe);
    for (const box of $$('[data-familiar]')) box.textContent = familiar.emoji;
  }

  function renderStars() {
    for (const node of $$('[data-stars]')) node.textContent = String(state.stars);
  }

  // ------------------------------------------------------------------
  // Sparkles and confetti
  // ------------------------------------------------------------------
  const fxLayer = $('#fx');

  function burst(x, y, glyphs, count, spread = 150) {
    if (calm()) return;
    for (let i = 0; i < count; i++) {
      const spark = el('span', 'spark', pick(glyphs));
      const angle = Math.random() * Math.PI * 2;
      const reach = spread * (0.45 + Math.random() * 0.75);
      spark.style.setProperty('--x', `${x}px`);
      spark.style.setProperty('--y', `${y}px`);
      spark.style.setProperty('--dx', `${Math.cos(angle) * reach}px`);
      spark.style.setProperty('--dy', `${Math.sin(angle) * reach - 30}px`);
      spark.style.setProperty('--rot', `${Math.round(Math.random() * 240 - 120)}deg`);
      spark.style.setProperty('--size', `${18 + Math.round(Math.random() * 22)}px`);
      spark.style.setProperty('--dur', `${700 + Math.round(Math.random() * 500)}ms`);
      spark.addEventListener('animationend', () => spark.remove());
      fxLayer.append(spark);
    }
  }

  function centerOf(node) {
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  function confetti(box, count) {
    box.textContent = '';
    if (calm()) return;
    const colors = ['#ff6fb5', '#ffd75e', '#8f5cf0', '#5bc0f8', '#6fdc8c', '#ffa94d'];
    for (let i = 0; i < count; i++) {
      const bit = el('i');
      bit.style.setProperty('--x', `${Math.round(Math.random() * 100)}%`);
      bit.style.setProperty('--c', colors[i % colors.length]);
      bit.style.setProperty('--delay', `${(Math.random() * 2.4).toFixed(2)}s`);
      bit.style.setProperty('--dur', `${(2.4 + Math.random() * 1.8).toFixed(2)}s`);
      bit.style.setProperty('--tilt', `${Math.round(Math.random() * 360)}deg`);
      box.append(bit);
    }
  }

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------
  const screens = $$('.screen');
  const playScreen = $('#screen-play');
  let activeScreen = 'home';

  function show(name) {
    if (activeScreen === 'parent' && name !== 'parent') $('#word-input').blur();
    if (activeScreen === 'play' && name !== 'play') {
      speech.hush();
      stopPeek();
      turn = null;
    }
    activeScreen = name;
    for (const screen of screens) screen.hidden = screen.dataset.screen !== name;
    document.body.dataset.screen = name;
    if (name === 'home') renderHome();
    if (name === 'wardrobe') renderWardrobe();
    if (name === 'book') renderBook();
    if (name === 'parent') renderParent();
    renderStars();
  }

  // ------------------------------------------------------------------
  // Speech notes (shown only when the device cannot talk)
  // ------------------------------------------------------------------
  function onSpeechChange() {
    const note = speech.works
      ? ''
      : '🔇 This device can’t say the spells out loud. You can still play — the spell will flash for a moment instead!';
    for (const node of $$('[data-speech-note]')) {
      node.textContent = note;
      node.hidden = !note;
    }
    renderVoiceStatus();
    if (activeScreen === 'play' && turn) {
      renderListenRow();
      if (!speech.works && turn.step > 1 && !turn.peeked) peek();
    }
  }

  // ------------------------------------------------------------------
  // Home
  // ------------------------------------------------------------------
  function roundWords() {
    const size = state.roundSize === 0 ? state.words.length : Math.min(state.roundSize, state.words.length);
    const fresh = state.words.filter((w) => !progressFor(w).mastered);
    const known = state.words
      .filter((w) => progressFor(w).mastered)
      .sort((a, b) => progressFor(a).mastered - progressFor(b).mastered || progressFor(a).last - progressFor(b).last);
    return fresh.concat(known).slice(0, size);
  }

  function renderHome() {
    const total = state.words.length;
    const mastered = state.words.filter((w) => progressFor(w).mastered).length;
    const ready = roundWords().length;
    $('#home-status').textContent = mastered === total
      ? `You know all ${plural(total, 'spell')}! Practice makes them stronger.`
      : `${plural(ready, 'spell')} ready · ${mastered} of ${total} mastered`;
  }

  // ------------------------------------------------------------------
  // A round of play
  // ------------------------------------------------------------------
  let session = null; // { items, queue, earned, unlocks }
  let turn = null;    // the word on screen right now
  let outcomeBag = [];

  function startRound() {
    const items = roundWords().map((word) => ({
      word,
      step: progressFor(word).step,
      misses: 0,
      done: false,
      stars: 0,
    }));
    session = { items, queue: items.slice(), earned: 0, unlocks: [] };
    hideResult();
    show('play');
    renderRoundProgress();
    nextTurn({ queue: true });
  }

  function nextTurn(speechOptions) {
    if (!session.queue.length) {
      finishRound();
      return;
    }
    turn = buildTurn(session.queue.shift());
    renderTurn();
    sayWord(speechOptions);
    if (!speech.works && turn.step > 1) peek();
  }

  function scramble(letters) {
    let mixed = letters;
    for (let tries = 0; tries < 12; tries++) {
      mixed = shuffle(letters);
      if (mixed.join('') !== letters.join('')) break;
    }
    return mixed;
  }

  // Which letters to hide for the "fill in" step (a bit under half of them).
  function pickBlanks(letters) {
    const spots = letters.map((ch, i) => (ch === "'" ? -1 : i)).filter((i) => i >= 0);
    const count = clamp(Math.round(spots.length * 0.45), 1, Math.max(1, spots.length - 1));
    return shuffle(spots).slice(0, count).sort((a, b) => a - b);
  }

  // A few extra letters that are not in the word, so filling in takes thought.
  function pickDecoys(letters, missing) {
    const spare = shuffle(ALPHABET.filter((ch) => !letters.includes(ch)));
    const decoys = [];
    if (missing.some((ch) => VOWELS.includes(ch))) {
      const vowel = spare.find((ch) => VOWELS.includes(ch));
      if (vowel) decoys.push(vowel);
    }
    const want = missing.length > 2 ? 3 : 2;
    for (const ch of spare) {
      if (decoys.length >= want) break;
      if (!decoys.includes(ch)) decoys.push(ch);
    }
    return decoys;
  }

  function buildTurn(item) {
    const letters = item.word.split('');
    const t = {
      item,
      word: item.word,
      step: item.step,
      letters,
      open: [],     // slot positions the player fills (steps 1-3)
      free: false,  // step 4: no slots shown, type as many letters as you like
      tiles: [],    // { ch, used }
      placed: [],   // { ch, tile } in the order they were tapped
      busy: false,
      peeked: false,
    };
    if (t.step === 2) {
      t.open = pickBlanks(letters);
      const missing = t.open.map((i) => letters[i]);
      t.tiles = shuffle(missing.concat(pickDecoys(letters, missing)));
    } else if (t.step === LAST_STEP) {
      t.free = true;
      t.tiles = state.words.some((w) => w.includes("'")) ? ALPHABET.concat("'") : ALPHABET.slice();
    } else {
      t.open = letters.map((_, i) => i);
      t.tiles = scramble(letters);
    }
    t.tiles = t.tiles.map((ch) => ({ ch, used: false }));
    return t;
  }

  const isReady = () => (turn.free ? turn.placed.length > 0 : turn.placed.length === turn.open.length);

  function currentGuess() {
    if (turn.free) return turn.placed.map((p) => p.ch).join('');
    const guess = turn.letters.slice();
    turn.open.forEach((slot, i) => { guess[slot] = turn.placed[i] ? turn.placed[i].ch : ''; });
    return guess.join('');
  }

  // ---------- drawing the turn ----------
  const slotsBox = $('#slots');
  const tilesBox = $('#tiles');
  const modelBox = $('#model');
  const undoBtn = $('#btn-undo');
  const castBtn = $('#btn-cast');

  function renderRoundProgress() {
    const box = $('#round-progress');
    box.textContent = '';
    for (const item of session.items) {
      box.append(el('span', item.done ? 'rp-star is-done' : 'rp-star', '★'));
    }
    const done = session.items.filter((i) => i.done).length;
    box.setAttribute('aria-label', `${done} of ${plural(session.items.length, 'spell')} mastered this round`);
  }

  function showModel(word, className) {
    modelBox.textContent = '';
    modelBox.className = `model ${className || ''}`;
    for (const ch of word) modelBox.append(el('span', 'model-letter', ch));
    modelBox.hidden = false;
  }

  function hideModel() {
    modelBox.hidden = true;
    modelBox.textContent = '';
  }

  function renderListenRow() {
    const canTryVoice = speech.status !== 'missing';
    $('#btn-hear').hidden = !canTryVoice;
    $('#btn-slow').hidden = !canTryVoice;
    $('#btn-peek').hidden = speech.works || turn.step === 1;
  }

  function renderTurn() {
    playScreen.dataset.step = String(turn.step);
    playScreen.classList.remove('is-casting-ok', 'is-casting-fizzle');
    for (const pip of $$('#ladder li')) {
      const n = Number(pip.dataset.pip);
      pip.classList.toggle('is-done', n < turn.step);
      pip.classList.toggle('is-now', n === turn.step);
    }
    $('#ladder').setAttribute('aria-label', `Spell power: step ${turn.step} of ${LAST_STEP}`);
    $('#prompt-title').textContent = STEP_TITLES[turn.step];
    stopPeek();
    if (turn.step === 1) showModel(turn.word);
    else hideModel();
    renderListenRow();

    tilesBox.textContent = '';
    tilesBox.className = `tiles${turn.free ? ' tiles-alpha' : ''}${turn.tiles.length > 26 ? ' has-extra' : ''}`;
    turn.tiles.forEach((tile, i) => {
      const btn = el('button', 'tile', tile.ch);
      btn.type = 'button';
      btn.dataset.letter = tile.ch;
      btn.dataset.tile = String(i);
      btn.setAttribute('aria-label', tile.ch === "'" ? 'apostrophe' : `letter ${tile.ch}`);
      tilesBox.append(btn);
    });
    refreshBoard(false);
  }

  // `pop` plays the little landing animation on the letter that was just placed.
  function renderSlots(pop) {
    slotsBox.textContent = '';
    const cells = [];
    let newest = -1;
    if (turn.free) {
      turn.placed.forEach((p) => cells.push({ ch: p.ch, kind: 'is-filled' }));
      if (turn.placed.length < FREE_MAX) cells.push({ ch: '', kind: 'is-next' });
      newest = turn.placed.length - 1;
    } else {
      turn.letters.forEach((ch, i) => {
        const at = turn.open.indexOf(i);
        if (at < 0) cells.push({ ch, kind: 'is-fixed' });
        else if (at < turn.placed.length) cells.push({ ch: turn.placed[at].ch, kind: 'is-filled' });
        else cells.push({ ch: '', kind: at === turn.placed.length ? 'is-next' : 'is-empty' });
      });
      if (turn.placed.length) newest = turn.open[turn.placed.length - 1];
    }
    slotsBox.style.setProperty('--n', String(Math.max(cells.length, 4)));
    cells.forEach((cell, i) => {
      const slot = el('span', `slot ${cell.kind}${pop && i === newest ? ' is-new' : ''}`, cell.ch);
      slot.style.setProperty('--i', String(i));
      slotsBox.append(slot);
    });
    slotsBox.setAttribute('aria-label', `Your spelling: ${cells.map((c) => c.ch || 'blank').join(', ')}`);
  }

  // Repaint slots, tiles and buttons after every tap.
  function refreshBoard(pop) {
    renderSlots(pop);
    const full = !turn.free && turn.placed.length >= turn.open.length;
    $$('.tile', tilesBox).forEach((btn, i) => {
      const used = turn.tiles[i].used;
      btn.classList.toggle('is-used', used);
      btn.classList.toggle('is-resting', !used && (full || turn.placed.length >= FREE_MAX));
      btn.disabled = used || turn.busy;
    });
    undoBtn.disabled = turn.busy || !turn.placed.length;
    const ready = isReady() && !turn.busy;
    castBtn.disabled = !ready;
    castBtn.classList.toggle('is-ready', ready);
  }

  // ---------- playing the turn ----------
  function tapTile(index) {
    if (!turn || turn.busy) return;
    const tile = turn.tiles[index];
    if (!tile || tile.used) return;
    const room = turn.free ? FREE_MAX : turn.open.length;
    if (turn.placed.length >= room) {
      nudge(castBtn);
      return;
    }
    turn.placed.push({ ch: tile.ch, tile: index });
    if (!turn.free) tile.used = true;
    chimes.tap();
    refreshBoard(true);
  }

  function undo() {
    if (!turn || turn.busy || !turn.placed.length) return;
    const last = turn.placed.pop();
    turn.tiles[last.tile].used = false;
    chimes.undo();
    refreshBoard(false);
  }

  function nudge(node) {
    node.classList.remove('is-nudged');
    void node.offsetWidth; // restart the animation
    node.classList.add('is-nudged');
  }

  function sayWord({ slow = false, queue = false } = {}) {
    if (!turn) return;
    speech.say(turn.word, { rate: slow ? SLOW_RATE : WORD_RATE, pitch: 1.05, queue });
  }

  // Without a voice, flash the word briefly: look, cover, spell.
  let peekTimer = 0;

  function peek() {
    if (!turn || turn.busy || turn.step === 1) return;
    turn.peeked = true;
    clearTimeout(peekTimer);
    showModel(turn.word, 'is-peek');
    peekTimer = setTimeout(stopPeek, PEEK_MS);
  }

  function stopPeek() {
    clearTimeout(peekTimer);
    peekTimer = 0;
    if (turn && turn.step !== 1) hideModel();
  }

  function cast() {
    if (!turn || turn.busy || !isReady()) return;
    const thisTurn = turn;
    const guess = currentGuess();
    const ok = guess === turn.word;
    turn.busy = true;
    stopPeek();
    refreshBoard(false);
    const info = settle(ok, guess);

    playScreen.classList.add(ok ? 'is-casting-ok' : 'is-casting-fizzle');
    const wand = $('.wand-star', playScreen);
    const slotsAt = centerOf(slotsBox);
    if (ok) {
      chimes.success();
      if (wand) { const at = centerOf(wand); burst(at.x, at.y, ['✨', '⭐', '💖', '✨'], 10, 130); }
      burst(slotsAt.x, slotsAt.y, ['✨', '⭐', '🌟', '💜'], 14, 220);
    } else {
      chimes.fizzle();
      burst(slotsAt.x, slotsAt.y, ['💨', '☁️'], 6, 110);
    }
    setTimeout(() => {
      if (turn === thisTurn && activeScreen === 'play') showResult(info);
    }, calm() ? 150 : 950);
  }

  // Works out what the cast means for the word's ladder, the queue and the stars.
  function settle(ok, guess) {
    const item = turn.item;
    const saved = progressFor(item.word);
    const info = { ok, word: item.word, guess, from: item.step, to: item.step, mastered: false, stars: 0, unlocks: [] };

    if (ok && item.step >= LAST_STEP) {
      item.done = true;
      item.stars = item.misses === 0 ? 3 : item.misses === 1 ? 2 : 1;
      const before = state.stars;
      state.stars += item.stars;
      session.earned += item.stars;
      saved.mastered += 1;
      saved.best = Math.max(saved.best, item.stars);
      saved.last = Date.now();
      saved.step = 3; // next time it is a quick review: unmix, then from sound
      info.mastered = true;
      info.stars = item.stars;
      info.unlocks = newUnlocks(before, state.stars);
      session.unlocks.push(...info.unlocks);
    } else {
      if (ok) {
        item.step += 1;
      } else {
        item.misses += 1;
        item.step = Math.max(1, item.step - 1);
      }
      saved.step = item.step;
      info.to = item.step;
      // Correct: come back after two other spells. Missed: a few turns later.
      const gap = ok ? 2 : 3;
      session.queue.splice(Math.min(gap, session.queue.length), 0, item);
    }
    saveState();
    return info;
  }

  function newUnlocks(before, after) {
    const fresh = (list, kind) => list
      .filter((thing) => thing.cost > before && thing.cost <= after)
      .map((thing) => ({ kind, name: thing.name, emoji: thing.emoji || '👗' }));
    return fresh(DATA.robes, 'robe').concat(fresh(DATA.familiars, 'familiar'));
  }

  // ---------- the result card ----------
  const resultBox = $('#result');
  let resultShownAt = 0;

  function nextOutcome() {
    if (!outcomeBag.length) outcomeBag = shuffle(DATA.outcomes);
    return outcomeBag.pop();
  }

  function renderScene(box, scene) {
    box.textContent = '';
    box.className = `scene move-${scene.move || 'bounce'}`;
    if (scene.rain) {
      const rain = el('div', 'scene-rain');
      for (let i = 0; i < 8; i++) {
        const drop = el('span', '', scene.rain);
        drop.style.setProperty('--x', `${4 + i * 12.5}%`);
        drop.style.setProperty('--delay', `${((i * 0.43) % 1.7).toFixed(2)}s`);
        rain.append(drop);
      }
      box.append(rain);
    }
    const actor = el('div', 'scene-actor');
    if (scene.hat) actor.append(el('span', 'scene-hat', scene.hat));
    actor.append(el('span', 'scene-main', scene.main));
    if (scene.ride) actor.append(el('span', 'scene-ride', scene.ride));
    box.append(actor);
    if (scene.orbit) {
      const ring = el('div', 'scene-orbit');
      for (let i = 0; i < 3; i++) {
        const item = el('span', '', scene.orbit);
        item.style.setProperty('--turn', `${i * 120}deg`);
        ring.append(item);
      }
      box.append(ring);
    }
  }

  function letterRow(box, word) {
    box.textContent = '';
    for (const ch of word) box.append(el('span', 'result-letter', ch));
    box.setAttribute('aria-label', word);
  }

  function showResult(info) {
    const title = $('#result-title');
    const text = $('#result-text');
    const starsBox = $('#result-stars');
    const extra = $('#result-extra');
    const nextBtn = $('#btn-next');
    const lastOne = session.queue.length === 0;
    starsBox.hidden = true;
    extra.hidden = true;
    extra.textContent = '';
    confetti($('#result-confetti'), 0);
    letterRow($('#result-word'), info.word);

    if (!info.ok) {
      resultBox.dataset.kind = 'fizzle';
      title.textContent = 'Oops! The spell fizzled';
      renderScene($('#result-scene'), { main: '💨', orbit: '✨', move: 'float' });
      text.textContent = `${pick(DATA.fizzles)} Here is the spell:`;
      extra.textContent = 'We’ll try it again soon!';
      extra.hidden = false;
      nextBtn.textContent = 'Keep going 💜';
      speech.say('Oops, the spell fizzled. We will try it again soon.', { rate: 0.95 });
    } else {
      const scene = nextOutcome();
      const cheer = pick(DATA.cheers);
      renderScene($('#result-scene'), scene);
      text.textContent = scene.say;
      if (info.mastered) {
        resultBox.dataset.kind = 'mastered';
        title.textContent = 'Spell mastered!';
        starsBox.textContent = '';
        for (let i = 1; i <= 3; i++) {
          const star = el('span', i <= info.stars ? 'big-star is-won' : 'big-star', '⭐');
          star.style.setProperty('--i', String(i));
          starsBox.append(star);
        }
        starsBox.setAttribute('aria-label', `You earned ${plural(info.stars, 'star')}`);
        starsBox.hidden = false;
        if (info.unlocks.length) {
          extra.textContent = info.unlocks.map((u) => `🎁 New: ${u.name}!`).join('  ');
          extra.hidden = false;
        }
        confetti($('#result-confetti'), 36);
        chimes.mastered();
        renderRoundProgress();
        renderStars();
        speech.say(`Spell mastered! ${scene.say}`, { rate: 0.95, pitch: 1.2 });
      } else {
        resultBox.dataset.kind = 'success';
        title.textContent = cheer;
        extra.textContent = `Spell power ${info.to - 1} of ${LAST_STEP}`;
        extra.hidden = false;
        speech.say(`${cheer} ${scene.say}`, { rate: 0.95, pitch: 1.2 });
      }
      nextBtn.textContent = lastOne ? 'Finish ➜' : 'Next spell ➜';
    }
    resultBox.hidden = false;
    resultShownAt = Date.now();
  }

  function hideResult() {
    resultBox.hidden = true;
    confetti($('#result-confetti'), 0);
  }

  function onNext() {
    if (resultBox.hidden || !session) return;
    if (Date.now() - resultShownAt < 350) return; // ignore a stray double-tap
    hideResult();
    nextTurn();
  }

  function finishRound() {
    turn = null;
    const earned = session.earned;
    const count = session.items.length;
    $('#done-summary').textContent =
      `You mastered ${plural(count, 'spell')} and earned ${plural(earned, 'star')}!`;
    const list = $('#done-words');
    list.textContent = '';
    for (const item of session.items) {
      const row = el('li', 'done-word');
      row.append(el('span', 'done-word-text', item.word), el('span', 'done-word-stars', '⭐'.repeat(item.stars)));
      list.append(row);
    }
    const unlockBox = $('#done-unlocks');
    unlockBox.textContent = '';
    for (const unlock of session.unlocks) {
      unlockBox.append(el('p', 'unlock', `🎁 New ${unlock.kind}: ${unlock.name}`));
    }
    show('done');
    const trophy = centerOf($('.done-trophy'));
    burst(trophy.x, trophy.y, ['⭐', '✨', '🌟', '💖', '💜'], 22, 260);
    chimes.mastered();
    speech.say(`Spellbook complete! You earned ${plural(earned, 'star')}!`, { rate: 0.95, pitch: 1.2 });
  }

  // ------------------------------------------------------------------
  // Wardrobe (robes and familiars)
  // ------------------------------------------------------------------
  function renderWardrobe() {
    const robe = currentRobe();
    const familiar = currentFamiliar();
    $('#wardrobe-caption').textContent = `${robe.name} robe · ${familiar.name}`;

    const fill = (boxId, things, chosenId, kind) => {
      const box = $(boxId);
      box.textContent = '';
      for (const thing of things) {
        const locked = thing.cost > state.stars;
        const btn = el('button', 'pick');
        btn.type = 'button';
        btn.dataset.kind = kind;
        btn.dataset.id = thing.id;
        btn.classList.toggle('is-locked', locked);
        btn.classList.toggle('is-chosen', thing.id === chosenId);
        btn.setAttribute('aria-pressed', String(thing.id === chosenId));
        btn.setAttribute('aria-label', locked ? `${thing.name}, locked. Needs ${plural(thing.cost, 'star')}.` : thing.name);
        const art = el('span', 'pick-art', kind === 'familiar' ? thing.emoji : '');
        if (kind === 'robe') {
          art.classList.add('pick-swatch');
          art.style.background = thing.rainbow
            ? `linear-gradient(135deg, ${thing.rainbow.join(', ')})`
            : `linear-gradient(160deg, ${thing.main}, ${thing.dark})`;
        }
        btn.append(art);
        btn.append(el('span', 'pick-name', kind === 'robe' ? thing.name : thing.name.split(' ')[0]));
        const chosenTag = kind === 'robe' ? '✓ Wearing' : '✓ With you';
        btn.append(el('span', 'pick-tag', locked ? `🔒 ${thing.cost} ⭐` : thing.id === chosenId ? chosenTag : 'Tap to pick'));
        box.append(btn);
      }
    };
    fill('#robe-picks', DATA.robes, robe.id, 'robe');
    fill('#familiar-picks', DATA.familiars, familiar.id, 'familiar');
  }

  function onPick(event) {
    const btn = event.target.closest('.pick');
    if (!btn) return;
    if (btn.classList.contains('is-locked')) {
      nudge(btn);
      return;
    }
    if (btn.dataset.kind === 'robe') state.robe = btn.dataset.id;
    else state.familiar = btn.dataset.id;
    saveState();
    chimes.unlock();
    chimes.tap();
    renderCasters();
    renderWardrobe();
    const at = centerOf($('#screen-wardrobe .witch'));
    burst(at.x, at.y, ['✨', '⭐', '💖'], 10, 170);
  }

  // ------------------------------------------------------------------
  // Spellbook (every word and its stars)
  // ------------------------------------------------------------------
  function renderBook() {
    const list = $('#book-list');
    list.textContent = '';
    for (const word of state.words) {
      const saved = progressFor(word);
      const row = el('li');
      const btn = el('button', 'book-word');
      btn.type = 'button';
      btn.dataset.word = word;
      btn.append(el('span', 'book-word-text', word));
      const stars = el('span', 'book-stars');
      for (let i = 1; i <= 3; i++) stars.append(el('span', i <= saved.best ? 'is-won' : '', '★'));
      stars.setAttribute('aria-label', `${plural(saved.best, 'star')}`);
      btn.append(stars);
      btn.append(el('span', 'book-note', saved.mastered ? '✨ Mastered' : `Step ${saved.step} of ${LAST_STEP}`));
      row.append(btn);
      list.append(row);
    }
  }

  // ------------------------------------------------------------------
  // Grown-ups' corner
  // ------------------------------------------------------------------
  const wordInput = $('#word-input');
  let resetArmed = 0;

  function renderParentWords(message) {
    const preview = $('#parent-preview');
    preview.textContent = '';
    for (const word of state.words) preview.append(el('span', 'chip', word));
    $('#parent-message').textContent = message ||
      `${state.custom ? 'Your list' : 'Starter list'}: ${plural(state.words.length, 'word')}.`;
  }

  function renderVoiceStatus() {
    const node = $('#voice-status');
    if (!node) return;
    if (speech.status === 'missing') {
      node.textContent = 'This browser cannot read words aloud, so each spell flashes on screen for a moment instead.';
    } else if (speech.status === 'novoices') {
      node.textContent = 'No voice was found on this device yet. Spells flash on screen for a moment instead.';
    } else {
      const voice = speech.voice || speech.pickVoice();
      node.textContent = voice
        ? `Voice: ${voice.name} (${voice.lang}). Turn the volume up so the spells can be heard.`
        : 'The voice wakes up when Start is tapped. Turn the volume up so the spells can be heard.';
    }
  }

  function renderParent() {
    wordInput.value = state.words.join('\n');
    renderParentWords();
    for (const btn of $$('#round-size .seg-btn')) {
      const chosen = Number(btn.dataset.size) === state.roundSize;
      btn.classList.toggle('is-chosen', chosen);
      btn.setAttribute('aria-pressed', String(chosen));
    }
    const sfxBtn = $('#btn-sfx');
    sfxBtn.textContent = `Chimes: ${state.chimes ? 'on' : 'off'}`;
    sfxBtn.setAttribute('aria-pressed', String(state.chimes));
    const mastered = state.words.filter((w) => progressFor(w).mastered).length;
    $('#parent-progress').textContent =
      `${mastered} of ${plural(state.words.length, 'word')} mastered · ${plural(state.stars, 'star')} earned.`;
    resetArmed = 0;
    $('#btn-reset').textContent = 'Reset stars & progress';
    renderVoiceStatus();
  }

  function saveWords() {
    const { words, skipped } = sanitizeWords(wordInput.value);
    if (!words.length) {
      $('#parent-message').textContent = 'Add at least one word (2 to 12 letters), or tap “Use starter list”.';
      return;
    }
    state.words = words;
    state.custom = true;
    saveState();
    wordInput.value = words.join('\n');
    wordInput.blur();
    const note = skipped.length ? ` Skipped: ${skipped.slice(0, 8).join(', ')}.` : '';
    renderParentWords(`Saved ${plural(words.length, 'word')}. The next round will use them.${note}`);
  }

  function useStarter() {
    state.words = DATA.starterWords.slice();
    state.custom = false;
    saveState();
    wordInput.value = state.words.join('\n');
    wordInput.blur();
    renderParentWords(`Starter list is ready (${plural(state.words.length, 'word')}).`);
  }

  function resetProgress() {
    const btn = $('#btn-reset');
    if (Date.now() - resetArmed > 4000) {
      resetArmed = Date.now();
      btn.textContent = 'Tap again to erase everything';
      return;
    }
    state.progress = {};
    state.stars = 0;
    state.robe = DATA.robes[0].id;
    state.familiar = DATA.familiars[0].id;
    saveState();
    renderCasters();
    renderStars();
    renderParent();
    $('#parent-progress').textContent = 'Stars and progress were reset.';
  }

  // The gate: a quick tap does nothing, holding for two seconds opens the door.
  function holdToOpen(btn, ms, open) {
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      timer = 0;
      btn.classList.remove('is-holding');
    };
    btn.addEventListener('pointerdown', (event) => {
      if (timer) return;
      if (event.pointerId != null && btn.setPointerCapture) {
        try { btn.setPointerCapture(event.pointerId); } catch (err) { /* fine without capture */ }
      }
      btn.classList.add('is-holding');
      timer = setTimeout(() => {
        stop();
        open();
      }, ms);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(type, stop);
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function begin() {
    // This runs inside the tap, which is what lets Safari speak and chime.
    chimes.unlock();
    speech.say('Let’s cast some spells!', { rate: 0.95, pitch: 1.2 });
    speech.scheduleCheck();
    startRound();
  }

  $('#btn-start').addEventListener('click', begin);
  $('#btn-again').addEventListener('click', begin);
  $('#btn-wardrobe').addEventListener('click', () => show('wardrobe'));
  $('#btn-done-wardrobe').addEventListener('click', () => show('wardrobe'));
  $('#btn-book').addEventListener('click', () => show('book'));
  $('#btn-done-home').addEventListener('click', () => show('home'));
  $('#btn-quit').addEventListener('click', () => {
    hideResult();
    session = null;
    show('home');
  });
  for (const btn of $$('[data-go]')) btn.addEventListener('click', () => show(btn.dataset.go));

  tilesBox.addEventListener('click', (event) => {
    const btn = event.target.closest('.tile');
    if (btn) tapTile(Number(btn.dataset.tile));
  });
  undoBtn.addEventListener('click', undo);
  castBtn.addEventListener('click', cast);
  $('#btn-next').addEventListener('click', onNext);
  $('#btn-hear').addEventListener('click', () => sayWord());
  $('#btn-slow').addEventListener('click', () => sayWord({ slow: true }));
  $('#btn-peek').addEventListener('click', peek);

  $('#robe-picks').addEventListener('click', onPick);
  $('#familiar-picks').addEventListener('click', onPick);
  $('#book-list').addEventListener('click', (event) => {
    const btn = event.target.closest('.book-word');
    if (btn) speech.say(btn.dataset.word, { pitch: 1.05 });
  });

  holdToOpen($('#btn-parent'), 2000, () => show('parent'));
  $('#btn-save-words').addEventListener('click', saveWords);
  $('#btn-starter').addEventListener('click', useStarter);
  $('#btn-reset').addEventListener('click', resetProgress);
  $('#btn-test-voice').addEventListener('click', () => {
    speech.say('Hello! I will read the spelling words.', { pitch: 1.05 });
    speech.scheduleCheck();
  });
  $('#btn-sfx').addEventListener('click', () => {
    state.chimes = !state.chimes;
    saveState();
    renderParent();
    chimes.unlock();
    chimes.success();
  });
  $('#round-size').addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn) return;
    state.roundSize = Number(btn.dataset.size);
    saveState();
    renderParent();
  });

  // A real keyboard (grown-up on a laptop) can play too. No text field is ever focused.
  document.addEventListener('keydown', (event) => {
    if (activeScreen !== 'play' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!resultBox.hidden) {
      if (event.key === 'Enter') {
        event.preventDefault();
        onNext();
      }
      return;
    }
    if (!turn) return;
    const key = event.key.toLowerCase();
    if (event.key === 'Backspace') {
      event.preventDefault();
      undo();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      cast();
    } else if (key.length === 1 && /[a-z']/.test(key)) {
      const index = turn.tiles.findIndex((tile) => tile.ch === key && !tile.used);
      if (index >= 0) tapTile(index);
    }
  });

  // Keep iPad Safari from pinch-zooming while little fingers tap fast.
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) speech.hush();
  });

  if (speech.status !== 'missing') {
    speech.pickVoice();
    try {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        speech.pickVoice();
        if (speech.voices().length && speech.status === 'novoices') speech.checkVoices();
        renderVoiceStatus();
      });
    } catch (err) { /* older Safari: voices are ready right away */ }
  }

  renderCasters();
  onSpeechChange();
  show('home');
})();
