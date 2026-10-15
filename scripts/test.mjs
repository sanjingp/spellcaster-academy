// End-to-end test for Spellcaster Academy.
// Plays both modes — Spells (spelling) and Potions (math) — the way a child
// would (taps only) at iPad sizes, in both orientations, and saves screenshots
// to screenshots/.
//
//   npm test              everything
//   npm test -- potions   only the scenarios with "potions" in their name
//   npm test -- math      only the math fluency scenarios (ten-frames, hints, drills, speedy brews, slow facts)
//   npm test -- "math fix"  only the scenarios for the findings of the math review (mathup/REVIEW-MATH.md)
//
// Uses WebKit when its browser is installed, otherwise Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const STORE_KEY = 'spellcaster-academy-v1';
const FACTS_KEY = 'spellcaster-academy-facts-v1'; // fact memory: its own key, next to the save above
const MIN_TAP = 60;

const SIZES = [
  { name: 'portrait', width: 820, height: 1180 },
  { name: 'landscape', width: 1180, height: 820 },
];

// What Safari really leaves for the page once its toolbars are showing,
// plus a smaller iPad, to be sure nothing gets squeezed off screen.
const TIGHT_SIZES = [
  { name: 'portrait-safari-bars', width: 820, height: 1086 },
  { name: 'landscape-safari-bars', width: 1180, height: 726 },
  { name: 'small-ipad-portrait', width: 768, height: 930 },
  { name: 'small-ipad-landscape', width: 1024, height: 674 },
];

// ---------------------------------------------------------------- reporting

const failures = [];
let checks = 0;

function check(ok, message, detail = '') {
  checks += 1;
  if (!ok) {
    failures.push(`${message}${detail ? ` — ${detail}` : ''}`);
    console.log(`    ✗ ${message}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- browser setup

// Replaces speechSynthesis with a recorder, so we can see what the game says.
//   setup.voices – [name, lang, localService] for each voice the device offers
//   setup.error  – every utterance fails with this error code instead of speaking
//                  (a test can change it later through window.__speechError)
//   setup.lasts  – every utterance takes this many ms, one after the other like a real
//                  voice, and cancel() cuts them off. Without it each is over in a moment.
//                  (window.__speechLasts changes it later; 'forever': the end is never reported)
// window.__setVoices(list) swaps the voices mid-visit and fires `voiceschanged`, as the browser does.
// window.__talking says whether a voice that takes its time still has something to say.
function speechStub(setup) {
  const spoken = [];
  const waiting = []; // utterances that take their time, in the order they are spoken
  let ending = 0;
  const toVoice = ([name, lang, localService]) => ({ name, lang, voiceURI: name, localService, default: false });
  const voices = (setup.voices || [
    ['Albert', 'en-US', true],
    ['Daniel', 'en-GB', true],
    ['Thomas', 'fr-FR', true],
    ['Samantha', 'en-US', true],
    ['Fred', 'en-US', true],
  ]).map(toVoice);
  const voiceListeners = [];
  window.__spoken = spoken;
  window.__speechError = setup.error || null;
  window.__speechLasts = setup.lasts || 0;
  Object.defineProperty(window, '__talking', { configurable: true, get: () => waiting.length > 0 });
  const speakNext = () => {
    const utterance = waiting[0];
    if (!utterance) return;
    if (utterance.onstart) utterance.onstart({});
    if (window.__speechLasts === 'forever') return;
    ending = setTimeout(() => {
      waiting.shift();
      if (utterance.onend) utterance.onend({});
      speakNext();
    }, window.__speechLasts);
  };
  window.__setVoices = (list) => {
    voices.splice(0, voices.length, ...list.map(toVoice)); // new voice objects each time, like a real refresh
    for (const listener of voiceListeners) listener(new Event('voiceschanged'));
  };
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.lang = '';
      this.voice = null;
    }
  };
  const synth = {
    paused: false,
    speaking: false,
    pending: false,
    getVoices: () => voices,
    speak(utterance) {
      spoken.push({
        text: utterance.text,
        rate: utterance.rate,
        lang: utterance.lang,
        voice: utterance.voice ? utterance.voice.name : null,
        local: utterance.voice ? utterance.voice.localService : null,
      });
      const error = window.__speechError;
      if (!error && window.__speechLasts) {
        waiting.push(utterance);
        setTimeout(() => { if (waiting[0] === utterance) speakNext(); }, 10);
        return;
      }
      setTimeout(() => {
        if (error) {
          if (utterance.onerror) utterance.onerror({ error: error === 'no-code' ? undefined : error });
          return;
        }
        if (utterance.onstart) utterance.onstart({});
        setTimeout(() => utterance.onend && utterance.onend({}), 20);
      }, 10);
    },
    cancel() {
      clearTimeout(ending);
      waiting.length = 0;
    },
    pause() {},
    resume() {},
    addEventListener(type, listener) {
      if (type === 'voiceschanged') voiceListeners.push(listener);
    },
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
}

// Pretends the browser has no speech at all.
function removeSpeech() {
  try { delete Object.getPrototypeOf(window).speechSynthesis; } catch (err) { /* ignore */ }
  try { delete window.speechSynthesis; } catch (err) { /* ignore */ }
  try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined }); } catch (err) { /* ignore */ }
  try { delete window.SpeechSynthesisUtterance; } catch (err) { /* ignore */ }
}

// Every localStorage write fails, the way a full disk or private browsing does.
// A test can let writes through again with window.__storageFull = false, or have
// only one key refused with window.__storageFull = 'that key' (the save that
// grew too big for what is left, while the smaller one still fits).
function fullStorage(full = true) {
  const write = Storage.prototype.setItem;
  window.__storageFull = full;
  Storage.prototype.setItem = function setItem(...args) {
    if (window.__storageFull === true || window.__storageFull === args[0]) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return write.apply(this, args);
  };
}

// Lets a test make time pass for the game without waiting: window.__wait(ms)
// moves the stopwatch the game times answers with.
function movableClock() {
  const real = performance.now.bind(performance);
  let skipped = 0;
  performance.now = () => real() + skipped;
  window.__wait = (ms) => { skipped += ms; };
}

// The browser refuses to hand over localStorage at all.
function blockedStorage() {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
  });
}

async function launchBrowser() {
  for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
    try {
      const browser = await type.launch();
      return { name, browser };
    } catch (err) {
      console.log(`  (${name} is not installed here, trying the next browser)`);
    }
  }
  throw new Error('No Playwright browser could be launched. Run: npx playwright install chromium');
}

// speech:  'stub' (five on-device voices), { voices, error } for a stub set up another way,
//          'none' (no speech API) or 'real' (the browser's own engine, untouched)
// storage: 'full' or 'blocked' to make saving fail; 'picky' saves everything until the
//          test sets window.__storageFull (see fullStorage)
// saved, savedFacts: what is already in localStorage (the game save, the fact memory);
//          a string is stored as it is, to try a damaged save
// clock:   true to let the test move the game's stopwatch (see movableClock)
async function openPage(browser, baseUrl, size, {
  speech = 'stub', saved = null, savedFacts = null, reducedMotion = 'no-preference', storage = null, clock = false,
} = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: true,
    reducedMotion,
  });
  await context.addInitScript(() => { window.SPELLCASTER_NO_CLIPS = true; });
  if (speech === 'stub') await context.addInitScript(speechStub, {});
  else if (speech === 'none') await context.addInitScript(removeSpeech);
  else if (speech !== 'real') await context.addInitScript(speechStub, speech);
  for (const [key, value] of [[STORE_KEY, saved], [FACTS_KEY, savedFacts]]) {
    if (!value) continue;
    await context.addInitScript(([key, value]) => {
      if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
    }, [key, typeof value === 'string' ? value : JSON.stringify(value)]);
  }
  if (clock) await context.addInitScript(movableClock);
  if (storage === 'full') await context.addInitScript(fullStorage);
  if (storage === 'picky') await context.addInitScript(fullStorage, false);
  if (storage === 'blocked') await context.addInitScript(blockedStorage);
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
  });
  page.on('request', (req) => requests.push(req.url()));
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  return { context, page, problems, requests };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ---------------------------------------------------------------- touch helpers

// A real finger tap at the middle of the element. Fails if the element is
// disabled or something else is covering it.
async function tap(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  const point = await locator.evaluate((node) => {
    if (node.disabled) return { error: 'it is disabled' };
    const aim = () => {
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit, ok: !!hit && (hit === node || node.contains(hit)) };
    };
    let at = aim();
    if (!at.ok) {
      // It may be off screen or scrolled out of sight inside a panel: scroll like a finger would.
      node.scrollIntoView({ block: 'center' });
      at = aim();
    }
    if (!at.ok) {
      return { error: `it is covered by <${at.hit ? at.hit.tagName.toLowerCase() : 'nothing'} class="${at.hit ? at.hit.className : ''}">` };
    }
    return { x: at.x, y: at.y };
  });
  if (point.error) throw new Error(`Cannot tap ${selector}: ${point.error}`);
  await page.touchscreen.tap(point.x, point.y);
}

// Press and hold with a finger (Chromium) or the mouse (other browsers).
async function hold(page, browserName, selector, ms) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(ms);
    await page.mouse.up();
  }
}

const readSaved = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || 'null'), STORE_KEY);
const readFacts = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || 'null'), FACTS_KEY);
const spokenList = (page) => page.evaluate(() => (window.__spoken || []).slice());
const isShowing = (page, selector) => page.locator(selector).isVisible();

// ---------------------------------------------------------------- reading the play screen

async function readTurn(page, words) {
  return page.evaluate((list) => {
    const play = document.querySelector('#screen-play');
    const spoken = window.__spoken || [];
    let word = list.length === 1 ? list[0] : null;
    for (let i = spoken.length - 1; i >= 0 && !word; i--) {
      if (list.includes(spoken[i].text)) word = spoken[i].text;
    }
    const model = document.querySelector('#model');
    const focus = document.activeElement;
    return {
      word,
      step: Number(play.dataset.step),
      title: document.querySelector('#prompt-title').textContent,
      model: model.hidden ? null : model.textContent,
      slots: [...document.querySelectorAll('#slots .slot')].map((slot) => ({
        ch: slot.textContent,
        fixed: slot.classList.contains('is-fixed'),
      })),
      tiles: [...document.querySelectorAll('#tiles .tile')].map((tile) => ({
        ch: tile.dataset.letter,
        used: tile.disabled,
      })),
      castReady: !document.querySelector('#btn-cast').disabled,
      focus: focus ? focus.tagName : '',
    };
  }, words);
}

const SPELL_ROWS = ['.topbar', '.stage', '#slots', '#tiles', '.actions'];
const BREW_ROWS = ['.topbar', '.stage', '#brew-slots', '#brew-tiles', '.actions'];

// Every tap target on a play screen (spells or potions) must be big enough for
// small fingers, on screen, and the rows must not overlap each other.
async function checkPlayLayout(page, label, root = '#screen-play', rowNames = SPELL_ROWS) {
  const report = await page.evaluate(({ minTap, root, rowNames }) => {
    const problems = [];
    const visible = (node) => node.offsetParent !== null;
    const targets = [...document.querySelectorAll(`${root} button`)].filter(visible);
    for (const node of targets) {
      const box = node.getBoundingClientRect();
      const name = node.id || node.dataset.letter || node.className;
      if (box.width < minTap - 0.5 || box.height < minTap - 0.5) {
        problems.push(`${name} is only ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
      if (box.left < -0.5 || box.top < -0.5 || box.right > window.innerWidth + 0.5 || box.bottom > window.innerHeight + 0.5) {
        problems.push(`${name} is off screen`);
      }
    }
    const rows = rowNames
      .map((sel) => ({ sel, box: document.querySelector(`${root} ${sel}`).getBoundingClientRect() }));
    rows.forEach((row, i) => {
      if (row.box.left < -0.5 || row.box.right > window.innerWidth + 0.5) problems.push(`${row.sel} is wider than the screen`);
      if (i && row.box.top < rows[i - 1].box.bottom - 1) {
        problems.push(`${row.sel} overlaps ${rows[i - 1].sel} by ${Math.round(rows[i - 1].box.bottom - row.box.top)}px`);
      }
    });
    for (const slot of document.querySelectorAll(`${root} .slots > *`)) {
      const box = slot.getBoundingClientRect();
      if (box.left < -0.5 || box.right > window.innerWidth + 0.5) { problems.push('an answer slot is off screen'); break; }
    }
    const last = rows[rows.length - 1].box;
    if (last.bottom > window.innerHeight + 0.5) problems.push('the Cast button row is below the screen');
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('the page scrolls sideways');
    return problems;
  }, { minTap: MIN_TAP, root, rowNames });
  check(report.length === 0, `${label}: play screen layout is tidy`, report.slice(0, 4).join('; '));
}

// The word being shown (to copy, or flashed when there is no voice) must sit
// inside its card: the box and every single letter, in one row.
async function checkModelFits(page, label, word) {
  const report = await page.evaluate((word) => {
    const problems = [];
    const model = document.querySelector('#model');
    if (model.hidden) return ['the word is not showing'];
    if (model.textContent !== word) problems.push(`it shows "${model.textContent}"`);
    const card = model.closest('.prompt-card').getBoundingClientRect();
    const inside = (node, name) => {
      const box = node.getBoundingClientRect();
      if (box.left < card.left - 0.5 || box.right > card.right + 0.5 || box.top < card.top - 0.5 || box.bottom > card.bottom + 0.5) {
        problems.push(`${name} spills out of the card (x ${Math.round(box.left)}–${Math.round(box.right)}, card ${Math.round(card.left)}–${Math.round(card.right)})`);
      }
      if (box.left < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight) problems.push(`${name} is off screen`);
    };
    inside(model, 'the word');
    [...model.children].forEach((letter, i) => inside(letter, `letter ${i + 1}`));
    if (new Set([...model.children].map((letter) => Math.round(letter.getBoundingClientRect().top))).size > 1) problems.push('the word breaks onto two lines');
    const size = parseFloat(getComputedStyle(model).fontSize);
    if (size < 24) problems.push(`the letters are only ${size}px`);
    return [...new Set(problems)];
  }, word);
  check(report.length === 0, `${label}: the whole word "${word}" fits inside its card`, report.slice(0, 3).join('; '));
}

// Which listen buttons can be tapped right now, e.g. "btn-hear btn-peek".
const listenButtons = (page) => page.evaluate(() => [...document.querySelectorAll('#listen-row button')]
  .filter((node) => node.offsetParent !== null).map((node) => node.id).join(' '));

// ---------------------------------------------------------------- playing

// Decide which tiles to tap, in order. With `miss`, the spelling is wrong on purpose.
function planTaps(turn, miss) {
  const word = turn.word;
  if (turn.step === 4) {
    if (!miss) return word.split('');
    return word.slice(0, -1).split('').concat(word.endsWith('z') ? 'q' : 'z');
  }
  const need = turn.slots.map((slot, i) => (slot.fixed ? null : word[i])).filter((ch) => ch !== null);
  if (!miss) return need;
  const spare = turn.tiles.map((tile) => tile.ch);
  for (const ch of need) spare.splice(spare.indexOf(ch), 1);
  const plan = need.slice();
  if (spare.length) {
    plan[0] = spare[0]; // a decoy letter
  } else {
    const other = plan.findIndex((ch) => ch !== plan[0]);
    [plan[0], plan[other]] = [plan[other], plan[0]];
  }
  return plan;
}

async function tapLetters(page, letters) {
  for (const ch of letters) {
    await tap(page, `#tiles .tile:not(:disabled)[data-letter="${ch}"]`);
  }
}

async function castAndSeeResult(page) {
  await tap(page, '#btn-cast');
  await page.waitForSelector('#result:not([hidden])');
  return page.getAttribute('#result', 'data-kind');
}

async function tapNext(page) {
  await sleep(420); // the game ignores a too-quick double tap
  await tap(page, '#btn-next');
  await page.waitForSelector('#result', { state: 'hidden' });
}

async function playTurn(page, words, { miss = false } = {}) {
  const turn = await readTurn(page, words);
  await tapLetters(page, planTaps(turn, miss));
  const kind = await castAndSeeResult(page);
  return { ...turn, kind };
}

// The main menu: two big buttons (Spells and Potions), with everything on screen.
async function checkHome(page, label) {
  const home = await page.evaluate(() => {
    const box = (node) => node.getBoundingClientRect();
    const modes = ['#btn-spells', '#btn-potions'].map((sel) => {
      const node = document.querySelector(sel);
      return { text: node.innerText.replace(/\s+/g, ' '), width: box(node).width, height: box(node).height };
    });
    const parts = [...document.querySelectorAll('#screen-home button, #screen-home .logo, #screen-home .witch')].map(box);
    const fits = parts.every((b) => b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth);
    const witch = box(document.querySelector('#screen-home .witch'));
    const covered = [...document.querySelectorAll('#screen-home .home-actions button')].map(box)
      .some((b) => b.left < witch.right && b.right > witch.left && b.top < witch.bottom - 6 && b.bottom > witch.top);
    return { modes, fits, covered };
  });
  check(/Spells/.test(home.modes[0].text) && /Potions/.test(home.modes[1].text), `${label}: the main menu offers Spells and Potions`,
    home.modes.map((m) => m.text).join(' | '));
  check(home.modes.every((m) => m.width >= 200 && m.height >= 90), `${label}: both mode buttons are big`,
    home.modes.map((m) => `${Math.round(m.width)}x${Math.round(m.height)}`).join(', '));
  check(home.fits, `${label}: home screen fits on the iPad`);
  check(!home.covered, `${label}: the home buttons do not cover the witch`);
}

// ---------------------------------------------------------------- scenario: the whole game

async function fullGame(browser, browserName, baseUrl, size) {
  const tag = size.name;
  const { context, page, problems, requests } = await openPage(browser, baseUrl, size);
  const starter = await page.evaluate(() => window.SPELLCASTER_DATA.starterWords.slice());

  // ---- home
  await sleep(500);
  await shot(page, `01-home-${tag}`);
  check(starter.length >= 10 && starter.length <= 14, `${tag}: starter list has about 12 words`, String(starter.length));
  check((await spokenList(page)).length === 0, `${tag}: nothing is spoken before a mode button is tapped`);
  await checkHome(page, tag);

  // ---- Start unlocks speech
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  let spoken = await spokenList(page);
  check(spoken.length >= 2, `${tag}: speechSynthesis.speak was called after tapping Spells`, `calls: ${spoken.length}`);
  const firstWord = spoken.find((s) => starter.includes(s.text));
  check(!!firstWord, `${tag}: the first spelling word is spoken`);
  if (firstWord) {
    check(Math.abs(firstWord.rate - 0.85) < 0.01, `${tag}: words are spoken at rate ~0.85`, String(firstWord.rate));
    check(firstWord.voice === 'Samantha', `${tag}: a clear en-US voice is chosen (not a novelty one)`, String(firstWord.voice));
    check(firstWord.lang === 'en-US', `${tag}: speech language is en-US`, String(firstWord.lang));
  }

  // ---- hear it again / slowly
  let before = (await spokenList(page)).length;
  await tap(page, '#btn-hear');
  await tap(page, '#btn-slow');
  spoken = await spokenList(page);
  check(spoken.length === before + 2, `${tag}: "Hear it again" and "Slowly" both speak`);
  check(spoken[spoken.length - 2].text === firstWord.text, `${tag}: "Hear it again" repeats the word`);
  check(spoken[spoken.length - 1].rate < 0.7, `${tag}: "Slowly" speaks slower`, String(spoken[spoken.length - 1].rate));

  // ---- undo tile
  let turn = await readTurn(page, starter);
  check(turn.step === 1, `${tag}: a new word starts at step 1 (copy)`, String(turn.step));
  check(turn.model === turn.word, `${tag}: step 1 shows the word to copy`, `${turn.model} vs ${turn.word}`);
  check(!turn.castReady, `${tag}: Cast is disabled until the slots are full`);
  check(await page.locator('#btn-undo').isDisabled(), `${tag}: Undo is disabled when nothing is placed`);
  await tap(page, '#tiles .tile:not(:disabled)');
  let after = await readTurn(page, starter);
  check(after.slots.filter((s) => s.ch).length === 1 && after.tiles.filter((t) => t.used).length === 1,
    `${tag}: tapping a tile places its letter and uses the tile up`);
  await tap(page, '#btn-undo');
  after = await readTurn(page, starter);
  check(after.slots.every((s) => !s.ch) && after.tiles.every((t) => !t.used), `${tag}: Undo takes the letter back`);

  // ---- play the whole round: every word climbs the ladder; misses drop a step
  const expected = new Map();   // word -> step it should show next time
  const misses = new Map();     // word -> number of misses
  const missedAt = new Map();   // word -> turn number of its last miss
  const seenSteps = new Set();
  const seenKinds = new Set();
  const mastered = [];
  let turnNo = 0;
  let missedStep1 = false;
  let missedStep3 = false;
  let dropVerified = false;
  let floorVerified = false;

  while (!(await isShowing(page, '#screen-done'))) {
    turnNo += 1;
    if (turnNo > 60) throw new Error('The round never finished');
    turn = await readTurn(page, starter);
    const { word, step } = turn;
    check(!!word, `${tag}: turn ${turnNo} speaks its word`);
    check(turn.focus !== 'INPUT' && turn.focus !== 'TEXTAREA', `${tag}: no text field is focused during play`, turn.focus);

    if (expected.has(word)) {
      check(step === expected.get(word), `${tag}: "${word}" comes back at step ${expected.get(word)}`, `shown at step ${step}`);
    } else {
      check(step === 1, `${tag}: new word "${word}" starts at step 1`, `step ${step}`);
    }
    if (missedAt.has(word)) {
      const gap = turnNo - missedAt.get(word) - 1;
      check(gap >= 2 && gap <= 4, `${tag}: a missed word is re-queued a few turns later`, `"${word}" came back after ${gap} other turn(s)`);
      if (step === 2) dropVerified = true;
      if (step === 1) floorVerified = true;
      missedAt.delete(word);
    }

    const sorted = (text) => text.split('').sort().join('');
    const tileLetters = turn.tiles.map((t) => t.ch).join('');
    if (step === 1) {
      check(turn.model === word, `${tag}: step 1 shows "${word}"`);
      check(sorted(tileLetters) === sorted(word), `${tag}: step 1 tiles are the word's letters`, tileLetters);
    } else if (step === 2) {
      const fixed = turn.slots.filter((s) => s.fixed);
      check(turn.model === null, `${tag}: step 2 does not show the whole word`);
      check(fixed.length >= 1 && fixed.length < word.length, `${tag}: step 2 has some letters missing`, `${fixed.length} given`);
      check(turn.slots.every((s, i) => !s.fixed || s.ch === word[i]), `${tag}: step 2 given letters are correct`);
      check(turn.slots.length === word.length, `${tag}: step 2 has one slot per letter`);
    } else if (step === 3) {
      check(turn.model === null, `${tag}: step 3 hides the word`);
      check(sorted(tileLetters) === sorted(word), `${tag}: step 3 uses only the word's letters`, tileLetters);
      check(tileLetters !== word, `${tag}: step 3 letters are mixed up`, tileLetters);
    } else if (step === 4) {
      check(turn.model === null, `${tag}: step 4 hides the word (sound only)`);
      check(tileLetters === 'abcdefghijklmnopqrstuvwxyz', `${tag}: step 4 offers the full alphabet`, tileLetters);
      check(turn.slots.length === 1 && !turn.slots[0].ch, `${tag}: step 4 gives no hint about the word's length`, `${turn.slots.length} slots`);
    }
    if (!seenSteps.has(step)) {
      seenSteps.add(step);
      await checkPlayLayout(page, `${tag} step ${step}`);
      // Screenshot with a few letters already placed, like a game in progress.
      const preview = planTaps(turn, false).slice(0, step === 2 ? 1 : 3);
      await tapLetters(page, preview);
      await sleep(350);
      await shot(page, `02-play-step${step}-${tag}`);
      for (let i = 0; i < preview.length; i++) await tap(page, '#btn-undo');
    }

    // Miss on purpose twice: once at step 1 (must stay at 1) and once at step 3 (must drop to 2).
    let miss = false;
    if (!missedStep1 && step === 1 && turnNo === 2) { miss = true; missedStep1 = true; }
    if (!missedStep3 && step === 3) { miss = true; missedStep3 = true; }

    await tapLetters(page, planTaps(turn, miss));
    const kind = await castAndSeeResult(page);
    if (miss) {
      check(kind === 'fizzle', `${tag}: a wrong spelling gently fizzles`, kind);
      misses.set(word, (misses.get(word) || 0) + 1);
      missedAt.set(word, turnNo);
      expected.set(word, Math.max(1, step - 1));
      const fizzleText = await page.locator('.result-card').innerText();
      check(/fizzled/i.test(fizzleText) && /try it again/i.test(fizzleText), `${tag}: fizzle message is kind`, fizzleText.replace(/\s+/g, ' '));
      check(!/[✗✘❌]|wrong|bad|fail/i.test(fizzleText), `${tag}: fizzle message never shames`, fizzleText.replace(/\s+/g, ' '));
      const shown = await page.locator('#result-word').getAttribute('aria-label');
      check(shown === word, `${tag}: fizzle card shows the right spelling`, String(shown));
    } else if (step === 4) {
      check(kind === 'mastered', `${tag}: finishing step 4 masters "${word}"`, kind);
      mastered.push(word);
      expected.delete(word);
    } else {
      check(kind === 'success', `${tag}: a right spelling at step ${step} succeeds`, kind);
      expected.set(word, step + 1);
    }
    if (!seenKinds.has(kind)) {
      seenKinds.add(kind);
      await sleep(kind === 'mastered' ? 1300 : 700);
      await shot(page, `03-result-${kind}-${tag}`);
      const cardFits = await page.evaluate(() => {
        const card = document.querySelector('.result-card').getBoundingClientRect();
        const next = document.querySelector('#btn-next').getBoundingClientRect();
        return card.top >= 0 && card.bottom <= window.innerHeight && next.bottom <= card.bottom && next.height >= 60;
      });
      check(cardFits, `${tag}: the ${kind} card fits on screen`);
    }
    await tapNext(page);
  }

  check(seenSteps.size === 4, `${tag}: all four ladder steps were played`, [...seenSteps].join(','));
  check(dropVerified, `${tag}: a miss at step 3 dropped the word to step 2`);
  check(floorVerified, `${tag}: a miss at step 1 stays at step 1`);
  check(mastered.length === 5, `${tag}: the round masters 5 words`, String(mastered.length));

  // ---- round complete: stars and unlocks
  await sleep(900);
  await shot(page, `04-round-complete-${tag}`);
  const wantStars = mastered.reduce((sum, word) => sum + Math.max(1, 3 - (misses.get(word) || 0)), 0);
  let saved = await readSaved(page);
  check(saved.stars === wantStars, `${tag}: stars per word are added up and saved`, `${saved.stars} vs ${wantStars}`);
  check(mastered.every((word) => saved.progress[word] && saved.progress[word].mastered === 1),
    `${tag}: mastered words are saved in localStorage`);
  check((await page.locator('#done-summary').innerText()).includes(`${wantStars} stars`), `${tag}: round summary shows the stars`);
  const unlockText = await page.locator('#done-unlocks').innerText();
  check(/Bubblegum Pink/.test(unlockText) && /Hoot the owl/.test(unlockText), `${tag}: new robe and familiar are announced`, unlockText);

  // ---- wardrobe: pick an unlocked robe and familiar; locked ones stay locked
  await tap(page, '#btn-done-wardrobe');
  await page.waitForSelector('#screen-wardrobe:not([hidden])');
  await tap(page, '.pick[data-kind="robe"][data-id="bubblegum"]');
  await tap(page, '.pick[data-kind="familiar"][data-id="owl"]');
  await tap(page, '.pick[data-kind="robe"][data-id="rainbow"]');
  await sleep(700);
  await shot(page, `05-wardrobe-${tag}`);
  saved = await readSaved(page);
  check(saved.robe === 'bubblegum' && saved.familiar === 'owl', `${tag}: chosen robe and familiar are saved`, `${saved.robe}/${saved.familiar}`);
  check((await page.locator('#screen-wardrobe [data-familiar]').innerText()).includes('🦉'), `${tag}: the familiar changes on screen`);
  const pickSizes = await page.evaluate(() => [...document.querySelectorAll('.pick')].every((n) => {
    const b = n.getBoundingClientRect();
    return b.width >= 60 && b.height >= 60;
  }));
  check(pickSizes, `${tag}: wardrobe buttons are big enough`);

  // ---- spellbook
  await tap(page, '#screen-wardrobe [data-go="home"]');
  await tap(page, '#btn-book');
  await page.waitForSelector('#screen-book:not([hidden])');
  await sleep(400);
  await shot(page, `06-spellbook-${tag}`);
  check((await page.locator('.book-word').count()) === starter.length, `${tag}: spellbook lists every word`);
  before = (await spokenList(page)).length;
  await tap(page, `.book-word[data-word="${mastered[0]}"]`);
  spoken = await spokenList(page);
  check(spoken.length === before + 1 && spoken[spoken.length - 1].text === mastered[0], `${tag}: tapping a spellbook word says it`);
  await tap(page, '#screen-book [data-go="home"]');

  // ---- grown-ups' gate
  await page.waitForSelector('#screen-home:not([hidden])');
  await tap(page, '#btn-parent');
  await sleep(500);
  check(!(await isShowing(page, '#screen-parent')), `${tag}: a quick tap does not open the grown-ups' corner`);
  await hold(page, browserName, '#btn-parent', 1000);
  await sleep(300);
  check(!(await isShowing(page, '#screen-parent')), `${tag}: a one-second hold is not enough`);
  await hold(page, browserName, '#btn-parent', 2300);
  await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  check(true, `${tag}: holding for two seconds opens the grown-ups' corner`);

  // ---- save a custom list (messy on purpose)
  const messy = ' Cat, DOG;\nfish  don’t CAT 123 su!n\n supercalifragilistic a  moon,,';
  const custom = ['cat', 'dog', 'fish', "don't", 'sun', 'moon'];
  await page.locator('#word-input').fill(messy);
  await tap(page, '#btn-save-words');
  saved = await readSaved(page);
  check(JSON.stringify(saved.words) === JSON.stringify(custom), `${tag}: custom words are cleaned, lowercased, de-duplicated and saved`, JSON.stringify(saved.words));
  check(saved.custom === true, `${tag}: the save remembers it is a custom list`);
  const message = await page.locator('#parent-message').innerText();
  check(/Saved 6 words/.test(message) && /supercalifragilistic/.test(message), `${tag}: parent sees what was saved and skipped`, message);
  const focusAfterSave = await page.evaluate(() => document.activeElement.tagName);
  check(focusAfterSave !== 'TEXTAREA', `${tag}: the keyboard is put away after saving`, focusAfterSave);
  await page.locator('.parent-body').evaluate((node) => { node.scrollTop = 0; });
  await sleep(300);
  await shot(page, `07-grownups-${tag}`);

  // ---- starter list button, then back to the custom list
  await tap(page, '#btn-starter');
  saved = await readSaved(page);
  check(JSON.stringify(saved.words) === JSON.stringify(starter) && saved.custom === false, `${tag}: "Use starter list" restores the starter words`);
  await page.locator('#word-input').fill('');
  await tap(page, '#btn-save-words');
  saved = await readSaved(page);
  check(saved.words.length === starter.length, `${tag}: saving an empty box keeps the old list`);
  await page.locator('#word-input').fill(custom.join(', '));
  await tap(page, '#btn-save-words');
  await tap(page, '#round-size [data-size="3"]');
  saved = await readSaved(page);
  check(saved.roundSize === 3 && saved.words.length === custom.length, `${tag}: spells-per-round setting is saved`);
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await page.waitForSelector('#screen-home:not([hidden])');

  // ---- everything survives a reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  saved = await readSaved(page);
  check(JSON.stringify(saved.words) === JSON.stringify(custom) && saved.stars === wantStars && saved.robe === 'bubblegum',
    `${tag}: words, stars and robe survive a reload`);
  check((await page.locator('#screen-home [data-stars]').innerText()).trim() === String(wantStars), `${tag}: home shows the saved stars`);
  await sleep(400);
  await shot(page, `08-home-after-playing-${tag}`);

  // ---- the next round uses the custom list (including an apostrophe word)
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  turn = await readTurn(page, custom);
  check(custom.includes(turn.word), `${tag}: the next round uses the custom words`, String(turn.word));
  check((await page.locator('#round-progress .rp-star').count()) === 3, `${tag}: the round has 3 spells, as chosen`);
  check(turn.focus !== 'TEXTAREA' && turn.focus !== 'INPUT', `${tag}: play starts with no text field focused`);
  const visibleInputs = await page.evaluate(() => [...document.querySelectorAll('input, textarea, [contenteditable]')]
    .filter((node) => node.offsetParent !== null).length);
  check(visibleInputs === 0, `${tag}: there is no text field on the play screen`);
  await tap(page, '#btn-quit');
  await page.waitForSelector('#screen-home:not([hidden])');

  const offsite = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith('data:'));
  check(offsite.length === 0, `${tag}: no network requests leave the site`, offsite.join(', '));
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- scenario: tight screens

// A long word at step 1 and an apostrophe word at step 4 are the hardest layouts.
async function tightLayouts(browser, baseUrl) {
  const cases = [
    { label: 'long word, copy step', word: 'hippopotamus', step: 1 },
    { label: 'apostrophe word, sound step', word: "couldn't", step: 4 },
  ];
  for (const size of [...SIZES, ...TIGHT_SIZES]) {
    for (const item of cases) {
      const saved = { words: [item.word], custom: true, progress: { [item.word]: { step: item.step, mastered: 0, best: 0, last: 0 } } };
      const { context, page, problems } = await openPage(browser, baseUrl, size, { saved });
      await tap(page, '#btn-spells');
      await page.waitForSelector('#screen-play:not([hidden])');
      const turn = await readTurn(page, [item.word]);
      check(turn.step === item.step, `${size.name}: saved step is used (${item.label})`, String(turn.step));
      if (item.step === 4) {
        check(turn.tiles.length === 27 && turn.tiles.some((t) => t.ch === "'"), `${size.name}: apostrophe tile appears for contractions`);
      }
      await tapLetters(page, planTaps(turn, false));
      await sleep(300);
      await checkPlayLayout(page, `${size.name} (${item.label})`);
      if (item.step === 1) await checkModelFits(page, `${size.name} (${item.label})`, item.word);
      if (TIGHT_SIZES.includes(size)) await shot(page, `09-tight-${size.name}-step${item.step}`);
      const kind = await castAndSeeResult(page);
      check(kind === (item.step === 4 ? 'mastered' : 'success'), `${size.name}: ${item.label} can be solved`, kind);
      await sleep(500);
      const cardFits = await page.evaluate(() => {
        const card = document.querySelector('.result-card').getBoundingClientRect();
        const next = document.querySelector('#btn-next').getBoundingClientRect();
        return card.top >= 0 && card.bottom <= window.innerHeight && next.bottom <= card.bottom + 1 && next.top > card.top;
      });
      check(cardFits, `${size.name}: result card fits (${item.label})`);
      if (TIGHT_SIZES.includes(size) && item.step === 4) await shot(page, `09-tight-${size.name}-mastered`);
      check(problems.length === 0, `${size.name}: no console errors (${item.label})`, problems.slice(0, 2).join(' | '));
      await context.close();
    }
  }
}

// ---------------------------------------------------------------- scenario: no speech

async function withoutSpeech(browser, baseUrl) {
  const size = SIZES[0];
  const saved = { words: ['magic'], custom: true, progress: { magic: { step: 3, mastered: 0, best: 0, last: 0 } } };
  const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: 'none', saved });
  check(await isShowing(page, '#screen-home [data-speech-note]'), 'no speech: home shows a friendly note');
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  check(await isShowing(page, '#screen-play [data-speech-note]'), 'no speech: play screen shows a friendly note');
  check(!(await isShowing(page, '#btn-hear')) && !(await isShowing(page, '#btn-slow')), 'no speech: the Hear and Slowly buttons are hidden');
  let turn = await readTurn(page, ['magic']);
  check(turn.model === 'magic', 'no speech: the word flashes at the start of the turn', String(turn.model));
  await sleep(300);
  await shot(page, '10-no-speech-peek-portrait');
  await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
  check(true, 'no speech: the flashed word hides again');
  check(await isShowing(page, '#btn-peek'), 'no speech: a Peek button is offered instead');
  await tap(page, '#btn-peek');
  turn = await readTurn(page, ['magic']);
  check(turn.model === 'magic', 'no speech: Peek shows the word again');
  let result = await playTurn(page, ['magic']);
  check(result.kind === 'success', 'no speech: step 3 can be solved', result.kind);
  await tapNext(page);
  result = await playTurn(page, ['magic']);
  check(result.step === 4 && result.kind === 'mastered', 'no speech: step 4 can be mastered', `${result.step} ${result.kind}`);
  await tapNext(page);
  await page.waitForSelector('#screen-done:not([hidden])');
  check(problems.length === 0, 'no speech: no console errors', problems.slice(0, 3).join(' | '));
  await context.close();

  // The browser's own speech engine, untouched. Headless browsers usually have
  // no voices, which should switch the game to peeking after a moment.
  const real = await openPage(browser, baseUrl, size, { speech: 'real', saved });
  await tap(real.page, '#btn-spells');
  await real.page.waitForSelector('#screen-play:not([hidden])');
  await sleep(1700);
  const voices = await real.page.evaluate(() => ('speechSynthesis' in window && window.speechSynthesis
    ? window.speechSynthesis.getVoices().filter((voice) => voice.localService === true && /^en/i.test(voice.lang)).length : -1));
  if (voices <= 0) {
    await real.page.waitForSelector('#model', { state: 'hidden', timeout: 5000 }); // the flashed word takes the buttons' place
    check(await isShowing(real.page, '#btn-peek'), 'no voices: Peek is offered when the device has no voice');
  } else {
    check(await isShowing(real.page, '#btn-hear'), 'real voices: Hear button is offered');
  }
  check(real.problems.length === 0, 'real speech engine: no console errors', real.problems.slice(0, 3).join(' | '));
  await real.context.close();
}

// ---------------------------------------------------------------- scenario: reduced motion

async function calmMode(browser, baseUrl) {
  const size = SIZES[1];
  const { context, page, problems } = await openPage(browser, baseUrl, size, { reducedMotion: 'reduce' });
  const starter = await page.evaluate(() => window.SPELLCASTER_DATA.starterWords.slice());
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  check((await running()) === 0, 'reduced motion: nothing animates on the home screen', String(await running()));
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  await sleep(200);
  check((await running()) === 0, 'reduced motion: nothing animates on the play screen', String(await running()));
  const result = await playTurn(page, starter);
  check(result.kind === 'success', 'reduced motion: a spell still works', result.kind);
  await sleep(300);
  check((await running()) === 0, 'reduced motion: the result card is still', String(await running()));
  check((await page.locator('#fx .spark').count()) === 0, 'reduced motion: no sparkle particles');
  await shot(page, '11-reduced-motion-result-landscape');
  await tapNext(page);
  check(problems.length === 0, 'reduced motion: no console errors', problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- potions: reading the brew screen

async function readBrew(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#brew-problem');
    const texts = (sel, root = box) => [...root.querySelectorAll(sel)].map((node) => node.textContent.trim());
    const turnOf = (sel) => {
      const hand = box.querySelector(sel);
      const match = /rotate\(([-\d.]+)/.exec(hand ? hand.getAttribute('transform') : '');
      return match ? Number(match[1]) : null;
    };
    const focus = document.activeElement;
    return {
      topic: document.querySelector('#screen-brew').dataset.topic,
      show: box.dataset.show,
      title: document.querySelector('#brew-title').textContent.trim(),
      equation: texts('.eq > span'),
      rods: box.querySelectorAll('.pv-rod').length,
      cubes: box.querySelectorAll('.pv-cube').length,
      sequence: texts('.seq-item'),
      story: texts('.story-line').join(' '),
      hourTurn: turnOf('.clock-hour'),
      minuteTurn: turnOf('.clock-minute'),
      coins: [...box.querySelectorAll('.coin')].map((node) => Number(node.dataset.cents)),
      coinLabels: texts('.coin'),
      slots: texts('.slot', document.querySelector('#brew-slots')),
      marks: texts('.slot-mark', document.querySelector('#brew-slots')),
      tiles: [...document.querySelectorAll('#brew-tiles .tile')].map((tile) => tile.dataset.digit),
      brewReady: !document.querySelector('#btn-brew').disabled,
      undoReady: !document.querySelector('#btn-brew-undo').disabled,
      focus: focus ? focus.tagName : '',
    };
  });
}

// Works out the answer from what is on the screen, the way a child would.
// It never looks at the game's own answer, so it also checks the game's math.
//   digits  – the tiles to tap          wrong   – tiles for a wrong answer
//   solved  – what the result card must show     numbers – every number in the problem
function solveBrew(seen) {
  const pad = (n) => String(n).padStart(2, '0');
  let answer = NaN;
  let numbers = [];
  let solved = null;
  if (seen.show === 'equation' && seen.equation[2] === '?') {
    const [left, , , , sum] = seen.equation; // "7 + ? = 10"
    answer = parseInt(sum, 10) - parseInt(left, 10);
    numbers = [parseInt(left, 10), answer, parseInt(sum, 10)];
    solved = new RegExp(`^${numbers[0]} \\+ ${answer} = ${numbers[2]}$`);
  } else if (seen.show === 'equation') {
    const [left, op, right] = seen.equation;
    const a = parseInt(left, 10);
    const b = parseInt(right, 10);
    if (op === '+') answer = a + b;
    if (op === '−') answer = a - b;
    if (op === 'and') answer = a * 10 + b; // "4 tens and 7 ones"
    numbers = op === 'and' ? [answer] : [a, b, answer];
    solved = new RegExp(`(=|make) ${answer}$`);
  } else if (seen.show === 'number') {
    const [, place, n] = /^How many (tens|ones) are in (\d+)\?$/.exec(seen.title) || [];
    answer = place === 'tens' ? Math.floor(n / 10) : n % 10;
    numbers = [Number(n)];
    solved = new RegExp(`^${n} has ${answer} (ten|one)s?$`);
  } else if (seen.show === 'blocks') {
    answer = seen.rods * 10 + seen.cubes;
    numbers = [answer];
    solved = new RegExp(`make ${answer}$`);
  } else if (seen.show === 'sequence') {
    const first = Number(seen.sequence[0]);
    const step = Number(seen.sequence[1]) - first;
    numbers = seen.sequence.map((_, i) => first + i * step);
    answer = numbers[seen.sequence.indexOf('?')];
    solved = new RegExp(`^${numbers.join(', ')}$`);
  } else if (seen.show === 'story') {
    const [a, b] = seen.story.match(/\d+/g).map(Number);
    answer = /left\?$/.test(seen.story) ? a - b : a + b;
    numbers = [a, b, answer];
    solved = new RegExp(`= ${answer}$`);
  } else if (seen.show === 'clock') {
    const hour = Math.floor(seen.hourTurn / 30) || 12;
    const minute = Math.round(seen.minuteTurn / 6);
    return {
      digits: `${hour}${pad(minute)}`,
      wrong: `${hour}${minute ? '00' : '30'}`,
      solved: new RegExp(`^${hour}:${pad(minute)}$`),
      numbers: [hour, minute],
    };
  } else if (seen.show === 'coins') {
    answer = seen.coins.reduce((sum, cents) => sum + cents, 0);
    numbers = seen.coins.concat(answer);
    solved = new RegExp(`= ${answer}¢$`);
  }
  return { digits: String(answer), wrong: String(answer + 1), solved, numbers };
}

// Turns a recipe into what readBrew() would see on screen, so the same solver checks both.
function asSeen(problem) {
  const show = problem.show;
  return {
    topic: problem.topic,
    show: show.type,
    title: problem.title,
    equation: show.parts || [],
    rods: show.tens,
    cubes: show.ones,
    sequence: (show.items || []).map((n) => (n === null ? '?' : String(n))),
    story: (show.lines || []).join(' '),
    hourTurn: show.type === 'clock' ? (show.hour % 12) * 30 + show.minute / 2 : null,
    minuteTurn: show.type === 'clock' ? show.minute * 6 : null,
    coins: show.cents || [],
  };
}

// Two turns show the same problem if everything on screen is the same.
const brewId = (seen) => JSON.stringify([seen.topic, seen.show, seen.title, seen.equation, seen.rods, seen.cubes,
  seen.sequence, seen.story, seen.hourTurn, seen.minuteTurn, seen.coins]);

// The picture of the problem (sum, blocks, clock, coins, story ...) must sit
// inside its card, below the title, and be big enough to read.
async function checkBrewPicture(page, label) {
  const report = await page.evaluate(() => {
    const problems = [];
    const card = document.querySelector('#screen-brew .prompt-card').getBoundingClientRect();
    const box = document.querySelector('#brew-problem');
    const title = document.querySelector('#screen-brew .prompt-title').getBoundingClientRect();
    const inside = (node, name) => {
      const b = node.getBoundingClientRect();
      if (b.width < 4 || b.height < 4) problems.push(`${name} is too small to see`);
      if (b.left < card.left - 0.5 || b.right > card.right + 0.5 || b.top < card.top - 0.5 || b.bottom > card.bottom + 0.5) {
        problems.push(`${name} spills out of the card`);
      }
      if (b.top < title.bottom - 1) problems.push(`${name} overlaps the title`);
    };
    const parts = box.querySelectorAll('.eq > span, .pv-rod, .pv-cube, .seq-item, .story-line, .story-emoji, .clock-svg, .coin');
    if (!parts.length) problems.push('nothing is drawn');
    for (const node of parts) inside(node, node.getAttribute('class'));
    const picture = box.getBoundingClientRect();
    for (const btn of document.querySelectorAll('#brew-listen:not([hidden]) button')) {
      inside(btn, btn.id);
      const b = btn.getBoundingClientRect();
      for (const node of parts) {
        const p = node.getBoundingClientRect();
        if (p.left < b.right && p.right > b.left && p.top < b.bottom && p.bottom > b.top) {
          problems.push(`${btn.id} covers the picture`);
          break;
        }
      }
    }
    if (title.left < card.left || title.right > card.right) problems.push('the title is wider than the card');
    if (card.left < 0 || card.right > window.innerWidth) problems.push('the card is off screen');
    const text = box.querySelector('.story-text, .eq, .seq-item, .coin');
    if (text && parseFloat(getComputedStyle(text).fontSize) < 16) problems.push('the writing is tiny');
    if (picture.height < 140) problems.push(`the picture box is only ${Math.round(picture.height)}px tall`);
    return [...new Set(problems)];
  });
  check(report.length === 0, `${label}: the problem picture fits in its card`, report.slice(0, 4).join('; '));
}

async function tapDigits(page, digits) {
  for (const digit of digits) await tap(page, `#brew-tiles .tile[data-digit="${digit}"]`);
}

// Home -> the Potions menu -> a round. `card` is the menu button to tap:
// mixed potions unless a drill or a speedy brew is asked for.
async function startPotions(page, card = '#btn-mix') {
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-potions:not([hidden])');
  await tap(page, card);
  await page.waitForSelector('#screen-brew:not([hidden])');
}

async function brewAndSeeResult(page) {
  await tap(page, '#btn-brew');
  await page.waitForSelector('#result:not([hidden])');
  return page.getAttribute('#result', 'data-kind');
}

const resultCardFits = (page) => page.evaluate(() => {
  const card = document.querySelector('.result-card').getBoundingClientRect();
  const next = document.querySelector('#btn-next').getBoundingClientRect();
  const word = document.querySelector('#result-word').getBoundingClientRect();
  return card.top >= 0 && card.bottom <= window.innerHeight && next.bottom <= card.bottom + 1 && next.top > card.top &&
    next.height >= 60 && word.left >= card.left && word.right <= card.right;
});

// The round-complete card must fit, with "Play again" reachable without scrolling.
const donePanelFits = (page) => page.evaluate(() => {
  const panel = document.querySelector('#screen-done .panel').getBoundingClientRect();
  const again = document.querySelector('#btn-again').getBoundingClientRect();
  return panel.top >= 0 && panel.bottom <= window.innerHeight && again.top >= panel.top && again.bottom <= panel.bottom &&
    again.bottom <= window.innerHeight && again.height >= 60;
});

// ---------------------------------------------------------------- scenario: potion recipes

const ALL_TOPICS = ['add', 'sub', 'place', 'skip', 'story', 'time', 'coins'];

// Thousands of generated problems, checked against the rules for each level.
// (Fast: the recipes are plain functions, so no tapping is needed.)
async function potionRecipes(browser, baseUrl) {
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0]);
  const data = await page.evaluate(() => {
    const P = window.SPELLCASTER_POTIONS;
    const samples = {};
    for (const level of P.levels) {
      for (const topic of P.topics) {
        samples[`${topic.id}/${level}`] = Array.from({ length: 400 }, () => P.makeProblem(topic.id, level));
      }
    }
    const only = (ids) => Object.fromEntries(P.topics.map((t) => [t.id, ids.includes(t.id)]));
    const everything = P.topics.map((t) => t.id);
    const rounds = (settings) => Array.from({ length: 40 }, () => P.makeRound(settings, 8).map((p) => ({ topic: p.topic, key: p.key })));
    return {
      levels: P.levels,
      topics: P.topics,
      samples,
      easySkip: Array.from({ length: 3000 }, () => P.makeProblem('skip', 'easy')),
      roundsEasySkip: rounds({ level: 'easy', topics: only(['skip']) }),
      roundsAll: rounds({ level: 'hundred', topics: only(everything) }),
      roundsSub: rounds({ level: 'easy', topics: only(['sub']) }),
      roundsTime: rounds({ level: 'easy', topics: only(['time']) }),
      roundsNone: rounds({ level: 'easy', topics: only([]) }),
      brews: P.brews,
      cheers: P.cheers,
      fizzles: P.fizzles,
      storyCount: P.stories.length,
    };
  });

  check(JSON.stringify(data.levels) === JSON.stringify(['easy', 'hundred']), 'recipes: two math levels (easy within 20, within 100)');
  check(JSON.stringify(data.topics.map((t) => t.id)) === JSON.stringify(ALL_TOPICS), 'recipes: all the topics are there',
    data.topics.map((t) => t.id).join(','));
  check(data.topics.every((t) => t.name && t.icon && /^#[0-9a-f]{6}$/.test(t.color)), 'recipes: every topic has a name, icon and potion color');

  for (const [name, list] of Object.entries(data.samples)) {
    const [topic, level] = name.split('/');
    const easy = level === 'easy';
    const bad = [];
    const note = (problem, why) => { if (bad.length < 3) bad.push(`${problem.key}: ${why}`); };
    for (const problem of list) {
      const seen = asSeen(problem);
      const want = solveBrew(seen);
      const show = problem.show;
      const solvedText = problem.solved.join('');
      if (problem.topic !== topic) note(problem, 'wrong topic');
      if (want.digits !== problem.answer) note(problem, `answer ${problem.answer}, but the screen says ${want.digits}`);
      if (!/^\d+$/.test(problem.answer)) note(problem, 'answer is not digits');
      if (problem.format === 'time' ? !/^\d{3,4}$/.test(problem.answer) : problem.answer.length > 3) note(problem, 'answer is too long to tap');
      if (!want.solved || !want.solved.test(solvedText)) note(problem, `result card shows "${solvedText}"`);
      if (!problem.title || problem.title.length > 26) note(problem, `title "${problem.title}"`);
      if (!problem.say || problem.say.length < 12) note(problem, 'nothing to read aloud');
      if (!problem.sayAnswer || !problem.label || problem.label.length > 30) note(problem, `label "${problem.label}"`);
      if (want.numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 100)) note(problem, `numbers ${want.numbers.join(',')}`);

      if (topic === 'add' || topic === 'sub' || topic === 'story') {
        if (easy && want.numbers.some((n) => n > 20)) note(problem, 'easy level must stay within 20');
        if (want.numbers[0] < 1 || want.numbers[1] < 1) note(problem, 'adds or takes away nothing');
      }
      if (topic === 'place' && (want.numbers[0] < 10 || (easy && want.numbers[0] > 20))) note(problem, 'place value number out of range');
      if (topic === 'skip') {
        const step = want.numbers[1] - want.numbers[0];
        const blank = show.items.indexOf(null);
        if (![2, 5, 10].includes(step)) note(problem, `counts by ${step}`);
        const count = show.items.length;
        if (count > 5 || count < (easy ? 3 : 5) || show.items.filter((n) => n === null).length !== 1 || blank < 2) note(problem, 'needs one blank after two numbers');
        if (easy && (blank !== count - 1 || want.numbers[0] % step !== 0)) note(problem, 'easy skip counting should start on a step and ask what is next');
        if (easy && want.numbers.some((n) => n > 20)) note(problem, 'easy level must stay within 20');
        if (!problem.title.includes(`${step}s`) || !problem.say.includes('blank')) note(problem, 'does not say what to count by');
      }
      if (topic === 'story') {
        if (!/\?$/.test(seen.story) || seen.story.length > 100 || show.lines.length !== 3) note(problem, `story "${seen.story}"`);
        if (problem.say !== seen.story) note(problem, 'story is not read aloud word for word');
        if (want.numbers[0] < 2 || want.numbers[1] < 2) note(problem, 'story numbers must be 2 or more (plurals)');
        if (/kill|dead|die|blood|hate|stupid|dumb|scar|hurt|gun|fight/i.test(seen.story)) note(problem, 'story is not kid-safe');
      }
      if (topic === 'time') {
        if (show.hour < 1 || show.hour > 12 || ![0, 30].includes(show.minute)) note(problem, 'not an hour or half hour');
        if (easy && show.minute !== 0) note(problem, 'easy level is on the hour only');
        if (problem.format !== 'time') note(problem, 'clock answers need h:mm boxes');
      }
      if (topic === 'coins') {
        if (show.cents.some((c) => ![1, 5, 10, 25].includes(c)) || show.cents.length < 2 || show.cents.length > 6) note(problem, `coins ${show.cents}`);
        if (easy && (want.numbers[want.numbers.length - 1] > 20 || show.cents.includes(25))) note(problem, 'easy coins must stay within 20 cents');
        if (problem.unit !== '¢') note(problem, 'no cent sign');
        if (show.cents.some((c, i) => i && c > show.cents[i - 1])) note(problem, 'coins are not sorted big to small');
      }
    }
    check(bad.length === 0, `recipes: ${list.length} ${level} "${topic}" problems are correct and in range`, bad.join(' | '));
    const kinds = new Set(list.map((problem) => problem.key)).size;
    check(kinds >= 10, `recipes: ${level} "${topic}" has plenty of different problems`, `${kinds} kinds`);
  }

  // Within 100 really is harder than easy: two-digit sums, regrouping, half hours, quarters.
  const hundred = (topic) => data.samples[`${topic}/hundred`];
  const parts = (problem) => problem.show.parts.map((part) => parseInt(part, 10));
  check(hundred('add').some((p) => Number(p.answer) > 50), 'recipes: within 100 has sums past 50');
  check(hundred('add').some((p) => (parts(p)[0] % 10) + (parts(p)[2] % 10) >= 10) &&
    hundred('add').some((p) => (parts(p)[0] % 10) + (parts(p)[2] % 10) < 10), 'recipes: within 100 adds with and without regrouping');
  check(hundred('sub').some((p) => parts(p)[0] % 10 < parts(p)[2] % 10) && hundred('sub').some((p) => parts(p)[0] > 50),
    'recipes: within 100 takes away with regrouping');
  check(hundred('time').some((p) => p.show.minute === 30) && hundred('time').some((p) => p.show.minute === 0),
    'recipes: within 100 tells time to the hour and half hour');
  check(hundred('coins').some((p) => p.show.cents.includes(25)), 'recipes: within 100 uses quarters');
  check(hundred('story').some((p) => /left\?$/.test(p.say)) && hundred('story').some((p) => !/left\?$/.test(p.say)),
    'recipes: stories both add and take away');
  check(new Set(hundred('story').map((p) => p.key.split(':')[1])).size === data.storyCount && data.storyCount >= 8,
    'recipes: every story template is used', String(data.storyCount));
  for (const form of ['blocks', 'equation', 'number']) {
    check(hundred('place').some((p) => p.show.type === form), `recipes: place value includes the "${form}" form`);
  }
  for (const step of [2, 5, 10]) {
    check(hundred('skip').some((p) => p.title === `Count by ${step}s`), `recipes: skip counting by ${step}s`);
  }

  // Easy means within 20 for skip counting too, whatever it counts by (3,000 more problems).
  const counted = (problem) => problem.show.items.map((n) => (n === null ? Number(problem.answer) : n));
  for (const step of [2, 5, 10]) {
    const list = data.easySkip.filter((p) => p.title === `Count by ${step}s`);
    const over = list.filter((p) => counted(p).some((n) => !Number.isInteger(n) || n < 0 || n > 20));
    const top = Math.max(...list.map((p) => Math.max(...counted(p))));
    check(list.length >= 100, `recipes: easy skip counting includes counting by ${step}s`, `${list.length} of ${data.easySkip.length}`);
    check(over.length === 0, `recipes: easy skip counting by ${step}s never goes past 20`,
      `${over.length} of ${list.length} do, such as ${over.slice(0, 2).map((p) => counted(p).join(', ')).join(' | ')}`);
    check(top === 20, `recipes: easy skip counting by ${step}s reaches 20`, String(top));
    check(list.every((p) => counted(p).every((n, i, all) => !i || n - all[i - 1] === step) && Number(p.answer) === counted(p)[counted(p).length - 1]),
      `recipes: easy skip counting by ${step}s counts evenly and asks for the next number`);
  }
  check(data.easySkip.filter((p) => p.title === 'Count by 10s').every((p) => counted(p).join(', ') === '0, 10, 20'),
    'recipes: easy counting by 10s is the short row 0, 10, ?');
  check(new Set(data.easySkip.map((p) => p.key)).size >= 20, 'recipes: easy skip counting still has plenty of different rows',
    String(new Set(data.easySkip.map((p) => p.key)).size));
  check(data.roundsEasySkip.every((round) => round.length === 8 && new Set(round.map((p) => p.key)).size === 8),
    'recipes: easy skip counting alone still fills a round without repeats');

  // Rounds: the right size, spread over the chosen topics, no repeats.
  const roundOk = (round, topics) => round.length === 8 && round.every((p) => topics.includes(p.topic)) &&
    new Set(round.map((p) => p.key)).size === 8;
  check(data.roundsAll.every((round) => roundOk(round, ALL_TOPICS) && ALL_TOPICS.every((t) => round.some((p) => p.topic === t))),
    'recipes: a round has 8 different potions and uses every topic that is on');
  check(data.roundsSub.every((round) => roundOk(round, ['sub'])), 'recipes: a round only uses the topics that are switched on');
  check(data.roundsTime.every((round) => roundOk(round, ['time'])), 'recipes: even a tiny topic fills a round without repeats');
  check(data.roundsNone.every((round) => roundOk(round, ['add'])), 'recipes: with no topic chosen, a round still has potions');

  // Brew results: silly, kind and kid-safe.
  check(data.brews.length >= 12 && data.brews.every((b) => b.main && /^Your potion made .+!$/.test(b.say)),
    'recipes: plenty of silly brew results', String(data.brews.length));
  const words = data.brews.map((b) => b.say).concat(data.fizzles, data.cheers).join(' ');
  check(!/kill|dead|die|blood|hate|stupid|dumb|scar|hurt|gun|fight|wrong|bad|fail/i.test(words), 'recipes: brew results and fizzle words are kid-safe and never scold');
  check(data.fizzles.length >= 3 && data.cheers.length >= 4, 'recipes: a few different cheers and gentle fizzle lines');
  check(problems.length === 0, 'recipes: no errors in the browser console', problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- scenario: a whole round of potions

async function potionsRound(browser, baseUrl, size) {
  const tag = `potions ${size.name}`;
  const file = size.name;
  // Four stars are already saved, as if earned in Spells: potion stars must add to them.
  const { context, page, problems, requests } = await openPage(browser, baseUrl, size, { saved: { stars: 4 } });

  // ---- main menu
  await sleep(400);
  await checkHome(page, tag);
  check((await spokenList(page)).length === 0, `${tag}: nothing is spoken before a mode button is tapped`);

  // ---- the Potions button starts a round and unlocks speech
  await startPotions(page);
  check(!(await isShowing(page, '#screen-play')), `${tag}: Potions opens the brewing screen, not the spelling one`);
  let spoken = await spokenList(page);
  check(spoken.length >= 2, `${tag}: speechSynthesis.speak was called after tapping Potions`, `calls: ${spoken.length}`);
  const prompt = spoken[spoken.length - 1];
  check(prompt.text.length > 12 && /\?$/.test(prompt.text), `${tag}: the first problem is read aloud`, prompt.text);
  check(Math.abs(prompt.rate - 0.85) < 0.01 && prompt.voice === 'Samantha' && prompt.lang === 'en-US',
    `${tag}: problems are read by a clear en-US voice at rate ~0.85`, `${prompt.rate} ${prompt.voice} ${prompt.lang}`);

  // ---- hear it again / slowly
  let before = spoken.length;
  await tap(page, '#btn-brew-hear');
  await tap(page, '#btn-brew-slow');
  spoken = await spokenList(page);
  check(spoken.length === before + 2 && spoken[before].text === prompt.text && spoken[before + 1].text === prompt.text,
    `${tag}: "Hear it again" and "Slowly" both read the problem`);
  check(spoken[before + 1].rate < 0.7, `${tag}: "Slowly" reads slower`, String(spoken[before + 1].rate));

  // ---- number tiles, undo and brew
  let seen = await readBrew(page);
  check(seen.tiles.slice().sort().join('') === '0123456789' && seen.tiles.length === 10, `${tag}: there are number tiles 0 to 9`, seen.tiles.join(''));
  check(!seen.brewReady, `${tag}: Brew is disabled until a number is tapped`);
  check(!seen.undoReady, `${tag}: Undo is disabled when nothing is typed`);
  await tap(page, '#brew-tiles .tile[data-digit="7"]');
  let after = await readBrew(page);
  check(after.slots.filter((ch) => ch).join('') === '7' && after.undoReady, `${tag}: tapping a number tile types it`, after.slots.join('|'));
  await tap(page, '#btn-brew-undo');
  after = await readBrew(page);
  check(after.slots.every((ch) => !ch) && !after.undoReady && !after.brewReady, `${tag}: Undo erases the number`);
  await tapDigits(page, '1234');
  after = await readBrew(page);
  const room = seen.show === 'clock' ? solveBrew(seen).digits.length : 3;
  check(after.slots.filter((ch) => ch).length === room, `${tag}: an answer cannot be longer than its boxes`, after.slots.join('|'));
  for (let i = 0; i < room; i++) await tap(page, '#btn-brew-undo');
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input, textarea, [contenteditable]')]
    .filter((node) => node.offsetParent !== null).length);
  check(inputs === 0, `${tag}: there is no text field on the brewing screen`);

  // ---- brew the whole round: the first two potions are missed on purpose
  const history = new Set();
  const missedAt = new Map(); // problem -> turn number of its miss
  const retried = new Set();  // problems that were missed once
  const topics = new Set();
  const kinds = new Set();
  let turnNo = 0;
  let brewed = 0;
  let stars = 0;
  let returned = 0;
  let gifts = 0;

  while (!(await isShowing(page, '#screen-done'))) {
    turnNo += 1;
    if (turnNo > 30) throw new Error('The potion round never finished');
    seen = await readBrew(page);
    const want = solveBrew(seen);
    const id = brewId(seen);
    const what = `turn ${turnNo} (${seen.topic})`;
    check(/^\d{1,4}$/.test(want.digits), `${tag}: ${what} can be solved from what is on screen`, want.digits);
    check(want.numbers.every((n) => n >= 0 && n <= 100), `${tag}: ${what} stays within 100`, want.numbers.join(','));
    check(seen.focus !== 'INPUT' && seen.focus !== 'TEXTAREA', `${tag}: no text field is focused while brewing`, seen.focus);
    check(ALL_TOPICS.includes(seen.topic), `${tag}: ${what} is a known topic`);
    spoken = await spokenList(page);
    const said = spoken[spoken.length - 1].text;
    if (seen.show === 'story') check(said === seen.story, `${tag}: the story problem is read aloud word for word`, said);
    else check(said.length > 12, `${tag}: ${what} is read aloud`, said);
    if (seen.show === 'coins') {
      check(seen.marks.join('') === '¢' && seen.coinLabels.every((text, i) => text === `${seen.coins[i]}¢`), `${tag}: coins show their value and the answer has a cent sign`);
    }
    if (seen.show === 'clock') {
      check(seen.marks.join('') === ':' && seen.slots.length === want.digits.length, `${tag}: the clock answer has h:mm boxes`, `${seen.slots.length} boxes`);
    }

    if (missedAt.has(id)) {
      const gap = turnNo - missedAt.get(id) - 1;
      check(gap >= 2 && gap <= 4, `${tag}: a missed potion comes back a few turns later`, `came back after ${gap} other turn(s)`);
      missedAt.delete(id);
      returned += 1;
    } else {
      check(!history.has(id), `${tag}: no potion shows up twice unless it was missed`, id);
    }
    history.add(id);

    if (!topics.has(seen.topic)) {
      topics.add(seen.topic);
      await checkPlayLayout(page, `${tag} ${seen.topic}`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${tag} ${seen.topic}`);
      // Screenshot with the answer typed in, like a game in progress.
      await tapDigits(page, want.digits);
      await sleep(350);
      await shot(page, `12-potions-${seen.topic}-${file}`);
      for (let i = 0; i < want.digits.length; i++) await tap(page, '#btn-brew-undo');
    }

    const miss = turnNo <= 2;
    await tapDigits(page, miss ? want.wrong : want.digits);
    const kind = await brewAndSeeResult(page);
    const shown = await page.locator('#result-word').getAttribute('aria-label');
    check(want.solved.test(shown), `${tag}: the result card shows the finished sum for ${what}`, String(shown));
    if (miss) {
      check(kind === 'fizzle', `${tag}: a wrong answer gently fizzles`, kind);
      missedAt.set(id, turnNo);
      retried.add(id);
      const fizzleText = (await page.locator('.result-card').innerText()).replace(/\s+/g, ' ');
      check(/potion fizzled/i.test(fizzleText) && /try it again/i.test(fizzleText), `${tag}: fizzle message is kind`, fizzleText);
      check(!/[✗✘❌]|wrong|bad|fail/i.test(fizzleText), `${tag}: fizzle message never shames`, fizzleText);
      spoken = await spokenList(page);
      check(/fizzled/i.test(spoken[spoken.length - 1].text) && /try it again/i.test(spoken[spoken.length - 1].text),
        `${tag}: the fizzle is spoken kindly, with the answer`, spoken[spoken.length - 1].text);
      check((await page.locator('#brew-progress .rp-star.is-done').count()) === brewed, `${tag}: a fizzle does not fill a progress star`);
    } else {
      check(kind === 'brewed', `${tag}: the right answer brews the potion for ${what}`, kind);
      const earned = retried.has(id) ? 1 : 2;
      brewed += 1;
      stars += earned;
      check((await page.locator('#result-stars .big-star.is-won').count()) === earned,
        `${tag}: ${retried.has(id) ? 'a potion brewed on the second try earns 1 star' : 'a first-try potion earns 2 stars'}`);
      check((await page.locator('#brew-progress .rp-star.is-done').count()) === brewed, `${tag}: the progress stars fill up`);
      check((await page.locator('#screen-brew [data-stars]').innerText()).trim() === String(4 + stars), `${tag}: the star count goes up`);
      const sillyText = await page.locator('#result-text').innerText();
      check(/^Your potion made .+!$/.test(sillyText), `${tag}: a brewed potion has a silly result`, sillyText);
      if (/New:/.test(await page.locator('#result-extra').innerText())) gifts += 1;
    }
    if (!kinds.has(kind)) {
      kinds.add(kind);
      await sleep(kind === 'brewed' ? 1100 : 700);
      await shot(page, `13-potions-result-${kind}-${file}`);
      check(await resultCardFits(page), `${tag}: the ${kind} card fits on screen`);
    }
    await tapNext(page);
  }

  check(brewed === 8, `${tag}: a round brews 8 potions`, String(brewed));
  check(turnNo === 10 && returned === 2, `${tag}: both missed potions came back and were brewed`, `${turnNo} turns, ${returned} returned`);
  check(topics.size === ALL_TOPICS.length, `${tag}: every topic showed up in the round`, [...topics].join(','));
  check(gifts >= 1, `${tag}: a brewed potion announces a newly unlocked reward`);

  // ---- round complete: stars are shared with spelling, rewards unlock
  await sleep(900);
  await shot(page, `14-potions-complete-${file}`);
  check(stars === 14, `${tag}: 6 first-try potions and 2 retried ones earn 14 stars`, String(stars));
  let saved = await readSaved(page);
  check(saved.stars === 4 + stars, `${tag}: potion stars are added to the shared star count and saved`, `${saved.stars} vs ${4 + stars}`);
  check(saved.math.brewed === 8, `${tag}: brewed potions are counted in localStorage`, String(saved.math.brewed));
  check(/potions/i.test(await page.locator('#done-title').innerText()), `${tag}: the round-complete card is about potions`);
  check((await page.locator('#done-summary').innerText()).includes(`8 potions and earned ${stars} stars`), `${tag}: round summary shows potions and stars`);
  check((await page.locator('#done-words .done-word').count()) === 8, `${tag}: the summary lists all 8 potions`);
  const unlockText = await page.locator('#done-unlocks').innerText();
  check(/Bubblegum Pink/.test(unlockText) && /Hoot the owl/.test(unlockText) && /Mermaid Teal/.test(unlockText),
    `${tag}: potion stars unlock robes and familiars`, unlockText);
  check(await donePanelFits(page), `${tag}: the round-complete card fits, with Play again in reach`);

  // ---- rewards are shared: a robe earned with potions can be worn
  await tap(page, '#btn-done-wardrobe');
  await page.waitForSelector('#screen-wardrobe:not([hidden])');
  await tap(page, '.pick[data-kind="robe"][data-id="mermaid"]');
  saved = await readSaved(page);
  check(saved.robe === 'mermaid', `${tag}: a robe unlocked with potion stars can be picked`, saved.robe);
  await tap(page, '#screen-wardrobe [data-go="home"]');

  // ---- home shows the shared stars; Spells still works and shows them too
  await page.waitForSelector('#screen-home:not([hidden])');
  await sleep(1400); // let the wardrobe sparkles finish
  await shot(page, `16-home-after-potions-${file}`);
  check((await page.locator('#screen-home [data-stars]').innerText()).trim() === String(4 + stars), `${tag}: home shows the shared stars`);
  check(/8 potions brewed/.test(await page.locator('#btn-potions').innerText()), `${tag}: home shows how many potions were brewed`);
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  check((await page.locator('#screen-play [data-stars]').innerText()).trim() === String(4 + stars), `${tag}: Spells shows the same stars`);
  check(!(await isShowing(page, '#screen-brew')), `${tag}: Spells opens the spelling screen`);
  await tap(page, '#btn-quit');
  await page.waitForSelector('#screen-home:not([hidden])');

  // ---- quitting a potion round and starting again
  await startPotions(page);
  check((await page.locator('#brew-progress .rp-star').count()) === 8 && (await page.locator('#brew-progress .rp-star.is-done').count()) === 0,
    `${tag}: a new round starts with 8 empty progress stars`);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check(!(await isShowing(page, '#result')), `${tag}: the home button leaves the round`);

  // ---- everything survives a reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  saved = await readSaved(page);
  check(saved.stars === 4 + stars && saved.math.brewed === 8 && saved.robe === 'mermaid', `${tag}: stars, potions and robe survive a reload`);

  const offsite = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith('data:'));
  check(offsite.length === 0, `${tag}: no network requests leave the site`, offsite.join(', '));
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- scenario: grown-ups choose the math

async function potionsSettings(browser, browserName, baseUrl) {
  const tag = 'potions settings';
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0]);
  const openParent = async () => {
    await hold(page, browserName, '#btn-parent', 2300);
    await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  };
  const readPanel = () => page.evaluate(() => {
    const pressed = (node) => node.getAttribute('aria-pressed') === 'true';
    const toggles = [...document.querySelectorAll('#math-topics .toggle')];
    return {
      level: [...document.querySelectorAll('#math-level .seg-btn')].filter(pressed).map((node) => node.dataset.level).join(','),
      all: toggles.map((node) => node.dataset.topic),
      on: toggles.filter(pressed).map((node) => node.dataset.topic),
      big: [...toggles, ...document.querySelectorAll('#math-level .seg-btn')].every((node) => {
        const box = node.getBoundingClientRect();
        return box.width >= 60 && box.height >= 60;
      }),
      message: document.querySelector('#math-message').textContent,
    };
  });
  const showPanel = () => page.locator('#math-level').evaluate((node) => node.closest('.panel').scrollIntoView({ block: 'center' }));

  // ---- defaults
  await openParent();
  let panel = await readPanel();
  check(panel.level === 'hundred', `${tag}: the math level starts at "within 100"`, panel.level);
  check(JSON.stringify(panel.all) === JSON.stringify(ALL_TOPICS) && panel.on.length === panel.all.length,
    `${tag}: every topic has a toggle and starts switched on`, `${panel.on.join(',')} of ${panel.all.join(',')}`);
  check(panel.big, `${tag}: level and topic buttons are big enough to tap`);

  // ---- choose the easy level and only "taking away"
  await tap(page, '#math-level [data-level="easy"]');
  let saved = await readSaved(page);
  check(saved.math.level === 'easy', `${tag}: the math level is saved in localStorage`, saved.math.level);
  for (const topic of ALL_TOPICS.filter((id) => id !== 'sub')) await tap(page, `#math-topics [data-topic="${topic}"]`);
  saved = await readSaved(page);
  check(ALL_TOPICS.every((id) => saved.math.topics[id] === (id === 'sub')), `${tag}: topic toggles are saved in localStorage`, JSON.stringify(saved.math.topics));
  await tap(page, '#math-topics [data-topic="sub"]');
  panel = await readPanel();
  saved = await readSaved(page);
  check(panel.on.join(',') === 'sub' && saved.math.topics.sub === true, `${tag}: the last topic cannot be switched off`);
  check(/at least one topic/i.test(panel.message), `${tag}: the grown-up is told to keep one topic on`, panel.message);
  await showPanel();
  await sleep(300);
  await shot(page, '15-grownups-potions-portrait');
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await page.waitForSelector('#screen-home:not([hidden])');

  // ---- the settings survive a reload and show again in the grown-ups' corner
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  await openParent();
  panel = await readPanel();
  check(panel.level === 'easy' && panel.on.join(',') === 'sub', `${tag}: level and topics survive a reload`, `${panel.level} / ${panel.on.join(',')}`);
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');

  // ---- the next round follows them: only taking away, within 20
  await startPotions(page);
  let turns = 0;
  while (!(await isShowing(page, '#screen-done'))) {
    turns += 1;
    if (turns > 12) throw new Error('The easy round never finished');
    const seen = await readBrew(page);
    const want = solveBrew(seen);
    check(seen.topic === 'sub' && seen.equation[1] === '−', `${tag}: easy round, turn ${turns} is taking away`, `${seen.topic} ${seen.equation.join(' ')}`);
    check(want.numbers.every((n) => n >= 0 && n <= 20), `${tag}: easy round, turn ${turns} stays within 20`, want.numbers.join(','));
    await tapDigits(page, want.digits);
    const kind = await brewAndSeeResult(page);
    check(kind === 'brewed', `${tag}: easy round, turn ${turns} brews`, kind);
    await tapNext(page);
  }
  saved = await readSaved(page);
  check(turns === 8 && saved.stars === 16 && saved.math.brewed === 8, `${tag}: a perfect round of 8 earns 16 stars`, `${turns} turns, ${saved.stars} stars`);

  // ---- back to within 100 with two other topics
  await tap(page, '#btn-done-home');
  await openParent();
  check((await page.locator('.parent-body').evaluate((node) => node.scrollTop)) === 0,
    `${tag}: the grown-ups' corner opens at the top each time`);
  await tap(page, '#math-level [data-level="hundred"]');
  await tap(page, '#math-topics [data-topic="time"]');
  await tap(page, '#math-topics [data-topic="coins"]');
  await tap(page, '#math-topics [data-topic="sub"]');
  saved = await readSaved(page);
  check(saved.math.level === 'hundred' && ALL_TOPICS.filter((id) => saved.math.topics[id]).join(',') === 'time,coins',
    `${tag}: topics can be switched back on`, JSON.stringify(saved.math));
  check(/8 potions brewed/.test(await page.locator('#parent-progress').innerText()), `${tag}: the grown-up sees how many potions were brewed`);
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await startPotions(page);
  let seen = await readBrew(page);
  check(['time', 'coins'].includes(seen.topic), `${tag}: the new topics are used right away`, seen.topic);
  await tap(page, '#btn-brew-quit');

  // ---- resetting progress clears the potion count but keeps the math settings
  await openParent();
  await page.locator('#btn-reset').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-reset');
  await tap(page, '#btn-reset');
  saved = await readSaved(page);
  check(saved.stars === 0 && saved.math.brewed === 0 && saved.math.level === 'hundred' && saved.math.topics.time === true && saved.math.topics.add === false,
    `${tag}: reset clears stars and potions but keeps the math settings`, JSON.stringify(saved.math));
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- a damaged or odd save never breaks the math settings
  const odd = await openPage(browser, baseUrl, SIZES[1], {
    saved: { math: { level: 'impossible', topics: { add: false, sub: false, place: false, skip: false, story: false, time: false, coins: false, extra: true }, brewed: -3 } },
  });
  await hold(odd.page, browserName, '#btn-parent', 2300);
  await odd.page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  const oddPanel = await odd.page.evaluate(() => ({
    level: document.querySelector('#math-level .seg-btn[aria-pressed="true"]').dataset.level,
    on: document.querySelectorAll('#math-topics .toggle[aria-pressed="true"]').length,
  }));
  check(oddPanel.level === 'hundred' && oddPanel.on === ALL_TOPICS.length, `${tag}: a damaged save falls back to the default math settings`, JSON.stringify(oddPanel));
  await odd.page.locator('#math-level').evaluate((node) => node.closest('.panel').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await shot(odd.page, '15-grownups-potions-landscape');
  check(odd.problems.length === 0, `${tag}: a damaged save causes no console errors`, odd.problems.slice(0, 3).join(' | '));
  await odd.context.close();
}

// ---------------------------------------------------------------- scenario: potions on tight screens

// The hardest pictures to fit: the longest story, six coins, 99 in blocks,
// a three-digit answer, 12:30 and the longest wordy sum. Runs with reduced
// motion so it is quick; the layout is the same.
async function potionsTight(browser, baseUrl) {
  const answers = ['69', '76', '99', '99', '100', '70', '1230', '4'];
  for (const size of [...SIZES, ...TIGHT_SIZES]) {
    const tag = `potions ${size.name}`;
    const tight = TIGHT_SIZES.includes(size);
    const { context, page, problems } = await openPage(browser, baseUrl, size, { reducedMotion: 'reduce' });
    await checkHome(page, tag);
    if (tight) await shot(page, `09-tight-${size.name}-home`);
    await page.evaluate(() => {
      const P = window.SPELLCASTER_POTIONS;
      const longest = P.stories.map((story, i) => [story.lines(99, 30).join(' ').length, i]).sort((a, b) => b[0] - a[0])[0][1];
      const round = [
        P.build.story(longest, 99, 30), P.build.coins([25, 25, 10, 10, 5, 1]), P.build.blocks(99), P.build.compose(99),
        P.build.skip(60, 10, 4), P.build.sub(100, 30), P.build.time(12, 30), P.build.digit(47, 'tens'),
      ];
      P.makeRound = () => round;
    });
    await startPotions(page);
    for (let i = 0; i < answers.length; i++) {
      const seen = await readBrew(page);
      const want = solveBrew(seen);
      check(want.digits === answers[i], `${tag}: the ${seen.show} problem reads as ${answers[i]}`, want.digits);
      await tapDigits(page, want.digits);
      await checkPlayLayout(page, `${tag} (${seen.show})`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${tag} (${seen.show})`);
      if (tight && ['story', 'coins', 'blocks', 'clock'].includes(seen.show)) await shot(page, `17-potions-tight-${size.name}-${seen.show}`);
      const kind = await brewAndSeeResult(page);
      check(kind === 'brewed', `${tag}: the ${seen.show} problem can be solved`, kind);
      await sleep(250);
      check(await resultCardFits(page), `${tag}: result card fits (${seen.show})`);
      if (tight && seen.show === 'coins') await shot(page, `17-potions-tight-${size.name}-result`);
      await tapNext(page);
    }
    await page.waitForSelector('#screen-done:not([hidden])');
    await sleep(250);
    check(await donePanelFits(page), `${tag}: the round-complete card fits, with Play again in reach`);
    if (tight) await shot(page, `17-potions-tight-${size.name}-complete`);
    await tap(page, '#btn-again');
    await page.waitForSelector('#screen-brew:not([hidden])');
    check(true, `${tag}: Play again starts another potion round`);
    check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 2).join(' | '));
    await context.close();
  }
}

// ---------------------------------------------------------------- scenario: potions without speech or motion

async function potionsQuiet(browser, baseUrl) {
  // No speech at all: the recipe is on screen, so the round still works.
  for (const size of [SIZES[0], TIGHT_SIZES[3]]) {
    const tag = `potions without speech (${size.name})`;
    const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: 'none' });
    await startPotions(page);
    check(await isShowing(page, '#screen-brew [data-speech-note]'), `${tag}: a friendly note is shown`);
    check(!(await isShowing(page, '#btn-brew-hear')) && !(await isShowing(page, '#btn-brew-slow')), `${tag}: the Hear buttons are hidden`);
    for (let i = 0; i < 3; i++) {
      const seen = await readBrew(page);
      const want = solveBrew(seen);
      await tapDigits(page, want.digits);
      await checkPlayLayout(page, `${tag} ${seen.show}`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${tag} ${seen.show}`);
      if (i === 0) {
        await sleep(300);
        await shot(page, `18-potions-no-speech-${size.name}`);
      }
      const kind = await brewAndSeeResult(page);
      check(kind === 'brewed', `${tag}: potion ${i + 1} can be brewed`, kind);
      await tapNext(page);
    }
    check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
    await context.close();
  }

  // The browser's own speech engine, untouched (headless browsers usually have no voices).
  const real = await openPage(browser, baseUrl, SIZES[1], { speech: 'real' });
  await startPotions(real.page);
  await sleep(1700);
  const voices = await real.page.evaluate(() => ('speechSynthesis' in window && window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1));
  const hearShown = await isShowing(real.page, '#btn-brew-hear');
  const noteShown = await isShowing(real.page, '#screen-brew [data-speech-note]');
  check(voices > 0 ? hearShown && !noteShown : noteShown && !hearShown, 'potions with the real speech engine: Hear buttons or the note, never both',
    `voices ${voices}, hear ${hearShown}, note ${noteShown}`);
  await checkPlayLayout(real.page, 'potions with the real speech engine', '#screen-brew', BREW_ROWS);
  await checkBrewPicture(real.page, 'potions with the real speech engine');
  check(real.problems.length === 0, 'potions with the real speech engine: no console errors', real.problems.slice(0, 3).join(' | '));
  await real.context.close();

  // Reduced motion: the cauldron stops bubbling and nothing flies around.
  const calm = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce' });
  const running = () => calm.page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  await startPotions(calm.page);
  await sleep(200);
  check((await running()) === 0, 'potions with reduced motion: nothing animates on the brewing screen', String(await running()));
  const seen = await readBrew(calm.page);
  await tapDigits(calm.page, solveBrew(seen).digits);
  const kind = await brewAndSeeResult(calm.page);
  check(kind === 'brewed', 'potions with reduced motion: a potion still brews', kind);
  await sleep(300);
  check((await running()) === 0, 'potions with reduced motion: the result card is still', String(await running()));
  check((await calm.page.locator('#fx .spark').count()) === 0, 'potions with reduced motion: no sparkle particles');
  await shot(calm.page, '19-potions-reduced-motion-landscape');
  await tapNext(calm.page);
  check(calm.problems.length === 0, 'potions with reduced motion: no console errors', calm.problems.slice(0, 3).join(' | '));
  await calm.context.close();
}

// ---------------------------------------------------------------- review fix 1: only on-device voices

const WORD_AT_STEP_4 = { words: ['magic'], custom: true, progress: { magic: { step: 4, mastered: 0, best: 0, last: 0 } } };

// The reviewer's case: a plain on-device voice next to "better" remote ones.
const VOICES_MIXED = [
  ['Google US English', 'en-US', false],
  ['Daniel', 'en-GB', true],
  ['Samantha', 'en-US', false],
  ['Ava (Premium)', 'en-US', null], // does not say where it lives, so it is not trusted
];
const VOICES_REMOTE = [
  ['Google US English', 'en-US', false],
  ['Samantha', 'en-US', false],
  ['Ava (Premium)', 'en-US', null],
];

async function localVoicesOnly(browser, browserName, baseUrl) {
  const openParent = async (page) => {
    await hold(page, browserName, '#btn-parent', 2300);
    await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  };

  // ---- an on-device voice next to remote ones: it does all the talking
  let tag = 'mixed voices';
  const mixed = await openPage(browser, baseUrl, SIZES[0], { speech: { voices: VOICES_MIXED }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
  let page = mixed.page;
  await sleep(1400); // past the voice check
  check(!(await isShowing(page, '#screen-home [data-speech-note]')), `${tag}: no "no voice" note, there is a voice on the device`);
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  let spoken = await spokenList(page);
  check(spoken.length === 2 && spoken[1].text === 'magic', `${tag}: the greeting and the spelling word are spoken`, spoken.map((s) => s.text).join(' | '));
  check(await listenButtons(page) === 'btn-hear btn-slow', `${tag}: the Hear buttons are offered, not Peek`, await listenButtons(page));
  await tap(page, '#btn-hear');
  await tap(page, '#btn-slow');
  let result = await playTurn(page, ['magic']);
  check(result.kind === 'mastered', `${tag}: the word can be spelled from sound`, result.kind);
  await tapNext(page);
  await page.waitForSelector('#screen-done:not([hidden])');
  await tap(page, '#btn-done-home');
  await tap(page, '#btn-book');
  await tap(page, '.book-word[data-word="magic"]');
  await tap(page, '#screen-book [data-go="home"]');
  await startPotions(page);
  await tap(page, '#btn-brew-hear');
  await tap(page, '#btn-brew-quit');
  await openParent(page);
  const voiceLine = await page.locator('#voice-status').innerText();
  check(/Daniel/.test(voiceLine) && /on this device/.test(voiceLine), `${tag}: the grown-up sees which on-device voice is used`, voiceLine);
  await page.locator('#btn-test-voice').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-test-voice');
  spoken = await spokenList(page);
  check(spoken.length >= 9, `${tag}: greetings, words, results, problems and the voice test were all spoken`, `${spoken.length} utterances`);
  const strays = spoken.filter((s) => s.voice !== 'Daniel' || s.local !== true);
  check(strays.length === 0, `${tag}: every utterance uses the on-device voice, never a remote or unnamed one`,
    strays.slice(0, 3).map((s) => `"${s.text}" by ${s.voice}`).join(' | '));
  check(spoken.every((s) => s.lang === 'en-GB'), `${tag}: the language follows the chosen voice`, [...new Set(spoken.map((s) => s.lang))].join(','));
  check(mixed.problems.length === 0, `${tag}: no console errors`, mixed.problems.slice(0, 3).join(' | '));
  await mixed.context.close();

  // ---- no on-device voice at all: nothing is spoken, the word is shown instead
  for (const [name, voices] of [['remote voices only', VOICES_REMOTE], ['an empty voice list', []]]) {
    tag = name;
    const quiet = await openPage(browser, baseUrl, SIZES[0], { speech: { voices }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
    page = quiet.page;
    await page.waitForSelector('#screen-home [data-speech-note]:not([hidden])', { timeout: 3000 }).catch(() => {});
    check(await isShowing(page, '#screen-home [data-speech-note]'), `${tag}: the home screen shows the friendly note`);
    await tap(page, '#btn-spells');
    await page.waitForSelector('#screen-play:not([hidden])');
    const turn = await readTurn(page, ['magic']);
    check(turn.step === 4 && turn.model === 'magic', `${tag}: the word is flashed on screen instead`, `step ${turn.step}, model ${turn.model}`);
    check(await isShowing(page, '#screen-play [data-speech-note]'), `${tag}: the play screen shows the friendly note`);
    await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
    check(await listenButtons(page) === 'btn-peek', `${tag}: only Peek is offered, no listening buttons that cannot work`, await listenButtons(page));
    await tap(page, '#btn-peek');
    check((await readTurn(page, ['magic'])).model === 'magic', `${tag}: Peek shows the word again`);
    result = await playTurn(page, ['magic']);
    check(result.kind === 'mastered', `${tag}: the word can still be mastered`, result.kind);
    await tapNext(page);
    await page.waitForSelector('#screen-done:not([hidden])');
    await tap(page, '#btn-done-home');
    await tap(page, '#btn-book');
    await tap(page, '.book-word[data-word="magic"]');
    await tap(page, '#screen-book [data-go="home"]');
    await startPotions(page);
    check(await isShowing(page, '#screen-brew [data-speech-note]') && !(await isShowing(page, '#btn-brew-hear')),
      `${tag}: Potions shows its note instead of the Hear buttons`);
    const seen = await readBrew(page);
    await tapDigits(page, solveBrew(seen).digits);
    check((await brewAndSeeResult(page)) === 'brewed', `${tag}: a potion can still be brewed`);
    await tapNext(page);
    await tap(page, '#btn-brew-quit');
    await openParent(page);
    const line = await page.locator('#voice-status').innerText();
    check(/flash/.test(line) && /never used/.test(line), `${tag}: the grown-up is told why there is no voice`, line);
    await page.locator('#btn-test-voice').evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await tap(page, '#btn-test-voice');
    await sleep(200);
    spoken = await spokenList(page);
    check(spoken.length === 0, `${tag}: speechSynthesis.speak is never called, not even without a voice chosen`,
      spoken.slice(0, 3).map((s) => `"${s.text}" by ${s.voice}`).join(' | '));
    check(quiet.problems.length === 0, `${tag}: no console errors`, quiet.problems.slice(0, 3).join(' | '));
    await quiet.context.close();
  }

  // ---- a device whose voices arrive late: quiet until an on-device one shows up
  tag = 'voices that arrive late';
  const late = await openPage(browser, baseUrl, SIZES[0], { speech: { voices: [] }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
  page = late.page;
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
  await page.evaluate((list) => {
    const voices = window.speechSynthesis.getVoices();
    for (const [name, lang, localService] of list) voices.push({ name, lang, voiceURI: name, localService, default: false });
  }, VOICES_MIXED);
  await tap(page, '#btn-peek'); // any tap; the game looks again when it next wants to speak
  await tap(page, '#btn-quit');
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  spoken = await spokenList(page);
  check(spoken.length === 2 && spoken.every((s) => s.voice === 'Daniel' && s.local === true), `${tag}: the on-device voice is used once it is there`,
    spoken.map((s) => `"${s.text}" by ${s.voice}`).join(' | '));
  check(await listenButtons(page) === 'btn-hear btn-slow' && !(await isShowing(page, '#screen-play [data-speech-note]')),
    `${tag}: the Hear buttons come back and the note goes away`, await listenButtons(page));
  check(late.problems.length === 0, `${tag}: no console errors`, late.problems.slice(0, 3).join(' | '));
  await late.context.close();
}

// ---------------------------------------------------------------- review fix 2: a voice that fails

async function speechFailures(browser, baseUrl) {
  const size = SIZES[0];

  // Each of these means "nothing was heard". 'no-code' is an error event without a code (older Safari).
  const broken = ['not-allowed', 'audio-busy', 'audio-hardware', 'network', 'synthesis-failed', 'voice-unavailable', 'no-code'];
  await Promise.all(broken.map(async (error) => {
    const tag = `speech error "${error}"`;
    const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: { error }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
    await tap(page, '#btn-spells');
    await page.waitForSelector('#screen-play:not([hidden])');
    const flashed = await page.waitForSelector('#model.is-peek', { state: 'visible', timeout: 3000 }).then(() => true, () => false);
    check(flashed && (await readTurn(page, ['magic'])).model === 'magic', `${tag}: the word is flashed when the voice fails`);
    check(await isShowing(page, '#screen-play [data-speech-note]'), `${tag}: the friendly note is shown`);
    await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
    check(await listenButtons(page) === 'btn-hear btn-peek', `${tag}: Peek is offered, with Hear for another try`, await listenButtons(page));

    // The voice is still listed, so the delayed voice check used to switch the fallback off again.
    await sleep(1500);
    check(await listenButtons(page) === 'btn-hear btn-peek' && await isShowing(page, '#screen-play [data-speech-note]'),
      `${tag}: Peek and the note are still there after the voice check`, await listenButtons(page));
    await tap(page, '#btn-peek');
    check((await readTurn(page, ['magic'])).model === 'magic', `${tag}: Peek shows the word`);
    await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });

    // Trying again and failing again changes nothing.
    await tap(page, '#btn-hear');
    await sleep(200);
    check(await listenButtons(page) === 'btn-hear btn-peek', `${tag}: a retry that fails keeps Peek`, await listenButtons(page));

    // Only a try that really speaks brings the normal buttons back.
    await page.evaluate(() => { window.__speechError = null; });
    await tap(page, '#btn-hear');
    await page.waitForSelector('#btn-peek', { state: 'hidden', timeout: 3000 }).catch(() => {});
    check(await listenButtons(page) === 'btn-hear btn-slow' && !(await isShowing(page, '#screen-play [data-speech-note]')),
      `${tag}: a retry that works brings Hear and Slowly back`, await listenButtons(page));
    check((await readTurn(page, ['magic'])).model === null, `${tag}: the word stays hidden once the voice works`);
    const result = await playTurn(page, ['magic']);
    check(result.kind === 'mastered', `${tag}: the word can be mastered`, result.kind);
    check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
    await context.close();
  }));

  // A word cut short on purpose is not a broken voice: the answer must not be shown.
  await Promise.all(['interrupted', 'canceled'].map(async (error) => {
    const tag = `speech error "${error}"`;
    const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: { error }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
    await page.evaluate(() => {
      window.__modelShown = 0;
      new MutationObserver(() => { if (!document.querySelector('#model').hidden) window.__modelShown += 1; })
        .observe(document.querySelector('#model'), { attributes: true, childList: true });
    });
    await tap(page, '#btn-spells');
    await page.waitForSelector('#screen-play:not([hidden])');
    await tap(page, '#btn-hear');
    await sleep(1600);
    check(await listenButtons(page) === 'btn-hear btn-slow', `${tag}: the normal buttons stay`, await listenButtons(page));
    check((await page.evaluate(() => window.__modelShown)) === 0, `${tag}: the word is never shown at the listening step`);
    check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
    await context.close();
  }));

  // Potions: the recipe is always on screen, so the Hear buttons simply stay for another try.
  const tag = 'speech error in Potions';
  const { context, page, problems } = await openPage(browser, baseUrl, TIGHT_SIZES[3], { speech: { error: 'not-allowed' }, reducedMotion: 'reduce' });
  await startPotions(page);
  await sleep(1500);
  const hear = await isShowing(page, '#btn-brew-hear');
  const note = await isShowing(page, '#screen-brew [data-speech-note]');
  check(hear && !note, `${tag}: the Hear buttons stay for another try, without the note`, `hear ${hear}, note ${note}`);
  await checkPlayLayout(page, tag, '#screen-brew', BREW_ROWS);
  await checkBrewPicture(page, tag);
  const seen = await readBrew(page);
  await tapDigits(page, solveBrew(seen).digits);
  check((await brewAndSeeResult(page)) === 'brewed', `${tag}: the potion can be brewed`);
  await tapNext(page);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check(await isShowing(page, '#screen-home [data-speech-note]'), `${tag}: the home screen says there is no voice right now`);
  check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- second review (REVIEW2.md): a failed voice and a refreshed voice list

const VOICE_ON_DEVICE = [['Samantha', 'en-US', true]];

// The second reviewer's case: the voice fails, then the browser refreshes its
// voice list — empty first, then the same on-device voice again. A voice that
// is merely listed again has still not been heard, so Peek and the note have
// to stay until a try really speaks.
async function voiceListRefresh(browser, browserName, baseUrl) {
  const setVoices = (page, list) => page.evaluate((voices) => window.__setVoices(voices), list);
  const spokenCount = async (page) => (await spokenList(page)).length;
  // What the play screen offers right now, e.g. "btn-hear btn-peek + note".
  const offered = async (page) => `${await listenButtons(page)}${await isShowing(page, '#screen-play [data-speech-note]') ? ' + note' : ''}`;

  // ---- the reviewer's steps, and the same with a list that only has online voices in it
  await Promise.all([['an empty voice list', []], ['only online voices', VOICES_REMOTE]].map(async ([name, gone]) => {
    const tag = `failed voice, then ${name}, then the voice again`;
    const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], {
      speech: { voices: VOICE_ON_DEVICE, error: 'not-allowed' }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce',
    });
    await tap(page, '#btn-spells');
    await page.waitForSelector('#screen-play:not([hidden])');
    await page.waitForSelector('#model.is-peek', { state: 'visible', timeout: 3000 }).catch(() => {});
    await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 }); // Peek has run out
    check(await offered(page) === 'btn-hear btn-peek + note', `${tag}: the failed voice leaves Hear, Peek and the note`, await offered(page));
    const triedBefore = await spokenCount(page);

    await setVoices(page, gone);
    check(await offered(page) === 'btn-peek + note', `${tag}: while no voice is listed, Peek and the note stay and Hear goes`, await offered(page));

    await setVoices(page, VOICE_ON_DEVICE);
    check(await offered(page) === 'btn-hear btn-peek + note', `${tag}: Peek and the note are still there once the voice is listed again`, await offered(page));
    check(await spokenCount(page) === triedBefore, `${tag}: nothing was spoken in between, so nothing has been heard yet`,
      `${await spokenCount(page) - triedBefore} new utterance(s)`);
    if (!gone.length) await shot(page, '23-voice-list-refresh-peek-kept-portrait');
    await tap(page, '#btn-peek');
    check((await readTurn(page, ['magic'])).model === 'magic', `${tag}: Peek still shows the word`);
    await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });

    // A retry that fails again changes nothing.
    await tap(page, '#btn-hear');
    await sleep(200);
    check(await spokenCount(page) === triedBefore + 1, `${tag}: Hear really tries the voice again`, `${await spokenCount(page) - triedBefore} new utterance(s)`);
    check(await offered(page) === 'btn-hear btn-peek + note', `${tag}: a retry that fails keeps Peek and the note`, await offered(page));

    // Only a retry that really plays brings the normal buttons back.
    await page.evaluate(() => { window.__speechError = null; });
    await tap(page, '#btn-hear');
    await page.waitForSelector('#btn-peek', { state: 'hidden', timeout: 3000 }).catch(() => {});
    check(await offered(page) === 'btn-hear btn-slow', `${tag}: a retry that plays brings Hear and Slowly back and clears the note`, await offered(page));
    const last = (await spokenList(page)).pop();
    check(last.text === 'magic' && last.voice === 'Samantha' && last.local === true, `${tag}: that retry spoke the word with the on-device voice`, `"${last.text}" by ${last.voice}`);
    const result = await playTurn(page, ['magic']);
    check(result.kind === 'mastered', `${tag}: the word can be mastered`, result.kind);
    check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
    await context.close();
  }));

  // ---- the list is refreshed while the word is still flashing; then Potions, home and the grown-ups' corner
  let tag = 'voice list refreshed during the flash';
  const flash = await openPage(browser, baseUrl, SIZES[1], {
    speech: { voices: VOICE_ON_DEVICE, error: 'synthesis-failed' }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce',
  });
  let page = flash.page;
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  await page.waitForSelector('#model.is-peek', { state: 'visible', timeout: 3000 }).catch(() => {});
  await setVoices(page, []);
  await setVoices(page, VOICE_ON_DEVICE);
  check((await readTurn(page, ['magic'])).model === 'magic', `${tag}: the word keeps flashing`);
  check(await isShowing(page, '#screen-play [data-speech-note]'), `${tag}: the note stays during the flash`);
  await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
  check(await offered(page) === 'btn-hear btn-peek + note', `${tag}: Hear, Peek and the note are there after the flash`, await offered(page));
  await tap(page, '#btn-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check(await isShowing(page, '#screen-home [data-speech-note]'), `${tag}: the home screen still says there is no voice right now`);

  tag = 'voice list refreshed in Potions';
  await startPotions(page); // tries the voice (it fails again) and starts the delayed voice check
  const brewOffers = async () => `hear ${await isShowing(page, '#btn-brew-hear')}, note ${await isShowing(page, '#screen-brew [data-speech-note]')}`;
  check(await brewOffers() === 'hear true, note false', `${tag}: a failed voice keeps the Hear buttons, the recipe is on screen anyway`, await brewOffers());
  await setVoices(page, []);
  check(await brewOffers() === 'hear false, note true', `${tag}: with no voice listed the note takes the place of the Hear buttons`, await brewOffers());
  await setVoices(page, VOICE_ON_DEVICE);
  check(await brewOffers() === 'hear true, note false', `${tag}: the Hear buttons are back with the voice, for another try`, await brewOffers());
  await sleep(1400); // past the delayed voice check
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check(await isShowing(page, '#screen-home [data-speech-note]'), `${tag}: the home screen still says there is no voice right now`);

  tag = 'voice list refreshed, grown-ups corner';
  const voiceLine = () => page.locator('#voice-status').innerText();
  await hold(page, browserName, '#btn-parent', 2300);
  await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  await page.locator('#btn-test-voice').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  check(/did not work/.test(await voiceLine()), `${tag}: the grown-up is told the voice did not work`, await voiceLine());
  await setVoices(page, []);
  check(/never used/.test(await voiceLine()), `${tag}: with no voice listed, the grown-up is told there is none`, await voiceLine());
  await setVoices(page, VOICE_ON_DEVICE);
  check(/did not work/.test(await voiceLine()), `${tag}: with the voice listed again, it still says the voice did not work`, await voiceLine());
  await shot(page, '23-voice-list-refresh-grownups-landscape');
  await tap(page, '#btn-test-voice'); // fails again, and starts the delayed voice check
  await sleep(1500);
  check(/did not work/.test(await voiceLine()), `${tag}: a voice test that fails leaves it that way, also after the voice check`, await voiceLine());
  await page.evaluate(() => { window.__speechError = null; });
  await tap(page, '#btn-test-voice');
  await page.waitForFunction(() => /Samantha/.test(document.querySelector('#voice-status').textContent), null, { timeout: 3000 }).catch(() => {});
  check(/Samantha/.test(await voiceLine()) && /on this device/.test(await voiceLine()), `${tag}: a voice test that plays names the voice again`, await voiceLine());
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await page.waitForSelector('#screen-home:not([hidden])');
  check(!(await isShowing(page, '#screen-home [data-speech-note]')), `${tag}: the home screen's note is gone once the voice has played`);
  check(flash.problems.length === 0, `${tag}: no console errors`, flash.problems.slice(0, 3).join(' | '));
  await flash.context.close();

  // ---- a voice that never failed is not held back by a refresh; one that fails while it is unlisted is
  tag = 'healthy voice, refreshed list';
  const healthy = await openPage(browser, baseUrl, SIZES[0], { speech: { voices: VOICE_ON_DEVICE }, saved: WORD_AT_STEP_4, reducedMotion: 'reduce' });
  page = healthy.page;
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  await sleep(1400); // past the delayed voice check
  check(await offered(page) === 'btn-hear btn-slow', `${tag}: a working voice offers Hear and Slowly`, await offered(page));
  await setVoices(page, []);
  check((await readTurn(page, ['magic'])).model === 'magic' && await isShowing(page, '#screen-play [data-speech-note]'),
    `${tag}: when the voice goes away the word is flashed, with the note`);
  await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
  check(await offered(page) === 'btn-peek + note', `${tag}: only Peek is offered while there is no voice`, await offered(page));
  await setVoices(page, VOICE_ON_DEVICE);
  check(await offered(page) === 'btn-hear btn-slow', `${tag}: a voice that never failed is trusted again as soon as it is back`, await offered(page));

  tag = 'voice lost in the middle of a word';
  // One step, so the list is already empty when the error for this try comes in.
  await page.evaluate(() => {
    window.__speechError = 'voice-unavailable';
    document.querySelector('#btn-hear').click();
    window.__setVoices([]);
  });
  await sleep(200);
  check(await offered(page) === 'btn-peek + note', `${tag}: only Peek is offered while there is no voice`, await offered(page));
  await setVoices(page, VOICE_ON_DEVICE);
  check(await offered(page) === 'btn-hear btn-peek + note', `${tag}: the try that failed is remembered when the voice is listed again`, await offered(page));
  await page.evaluate(() => { window.__speechError = null; });
  await tap(page, '#btn-hear');
  await page.waitForSelector('#btn-peek', { state: 'hidden', timeout: 3000 }).catch(() => {});
  check(await offered(page) === 'btn-hear btn-slow', `${tag}: a retry that plays brings Hear and Slowly back and clears the note`, await offered(page));
  check(healthy.problems.length === 0, `${tag}: no console errors`, healthy.problems.slice(0, 3).join(' | '));
  await healthy.context.close();
}

// ---------------------------------------------------------------- review fix 3: a missed word comes back soon

// The reviewer's case: five words, the first one missed, everything after it
// right. It used to come back after twelve other turns.
async function retryGap(browser, baseUrl) {
  const tag = 'retry gap';
  const words = ['cat', 'dog', 'sun', 'hat', 'run'];
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { saved: { words, custom: true, roundSize: 5 }, reducedMotion: 'reduce' });
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');

  const order = [];
  const unfinished = new Set(words);
  const missedAt = new Map(); // word -> { turnNo, others } for a miss still waiting to come back
  const gaps = [];
  const expected = new Map();
  let turnNo = 0;
  let laterMiss = false;
  while (!(await isShowing(page, '#screen-done'))) {
    turnNo += 1;
    if (turnNo > 45) throw new Error('The round never finished');
    const turn = await readTurn(page, words);
    order.push(turn.word);
    if (missedAt.has(turn.word)) {
      const { at, others } = missedAt.get(turn.word);
      gaps.push({ word: turn.word, gap: turnNo - at - 1, others, step: turn.step, want: expected.get(turn.word) });
      missedAt.delete(turn.word);
    }
    // Miss "cat" on its very first turn, and later the first word to reach step 3.
    let miss = turnNo === 1;
    if (!laterMiss && turn.step === 3 && unfinished.size >= 5 && !missedAt.size) { miss = true; laterMiss = true; }
    await tapLetters(page, planTaps(turn, miss));
    const kind = await castAndSeeResult(page);
    if (miss) {
      missedAt.set(turn.word, { at: turnNo, others: unfinished.size - 1 });
      expected.set(turn.word, Math.max(1, turn.step - 1));
    }
    if (kind === 'mastered') unfinished.delete(turn.word);
    await tapNext(page);
  }

  check(order.slice(0, 5).join(' ') === 'cat dog sun hat cat', `${tag}: a word missed on turn 1 is back on turn 5`, order.slice(0, 14).join(' '));
  check(gaps.length === 2, `${tag}: both missed words came back`, JSON.stringify(gaps));
  for (const { word, gap, others, step, want } of gaps) {
    check(others >= 4, `${tag}: "${word}" was missed with at least four other unfinished words`, String(others));
    check(gap === 3, `${tag}: "${word}" came back after exactly three other turns, however well they went`, `${gap} other turn(s)`);
    check(step === want, `${tag}: "${word}" came back one step lower`, `step ${step}, expected ${want}`);
  }
  check(unfinished.size === 0 && new Set(order).size === 5, `${tag}: every word still gets its turn and is mastered`, [...unfinished].join(','));
  check(turnNo === 23, `${tag}: five words, four steps each, plus the turns the two misses cost is 23 turns`, String(turnNo));
  check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- review fix 4: the word "constructor"

// "constructor" is an ordinary 11-letter word, and also the name of something
// every JavaScript object carries. It must climb the ladder like any other word.
async function constructorWord(browser, browserName, baseUrl) {
  const tag = 'the word "constructor"';
  const word = 'constructor';
  const titles = { 1: 'Copy the spell', 2: 'Fill in the missing letters', 3: 'Unmix the letters', 4: 'Listen and spell' };
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce' });
  const openParent = async () => {
    await hold(page, browserName, '#btn-parent', 2300);
    await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  };
  // Looks the record up the safe way: `saved.progress.constructor` alone would find Object itself.
  const record = () => page.evaluate(([key, w]) => {
    const saved = JSON.parse(window.localStorage.getItem(key) || 'null');
    const own = !!saved && Object.prototype.hasOwnProperty.call(saved.progress, w);
    return { own, stars: saved ? saved.stars : null, ...(own ? saved.progress[w] : {}) };
  }, [STORE_KEY, word]);

  // ---- a grown-up types it in
  await openParent();
  await page.locator('#word-input').fill('Constructor');
  await tap(page, '#btn-save-words');
  check(/Saved 1 word/.test(await page.locator('#parent-message').innerText()), `${tag}: is accepted as a spelling word`);
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  check((await page.locator('#spells-status').innerText()) === '0 of 1 word mastered', `${tag}: starts out not mastered`,
    await page.locator('#spells-status').innerText());

  // ---- it climbs all four steps
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  for (const step of [1, 2, 3, 4]) {
    const turn = await readTurn(page, [word]);
    check(turn.step === step && turn.title === titles[step], `${tag}: turn ${step} is step ${step}, "${titles[step]}"`, `step ${turn.step}, "${turn.title}"`);
    if (step === 1) await checkModelFits(page, tag, word);
    await tapLetters(page, planTaps(turn, false));
    const kind = await castAndSeeResult(page);
    check(kind === (step === 4 ? 'mastered' : 'success'), `${tag}: a right spelling at step ${step} moves it up`, kind);
    if (step < 4) check((await record()).step === step + 1, `${tag}: step ${step + 1} is saved`, JSON.stringify(await record()));
    await tapNext(page);
  }
  await page.waitForSelector('#screen-done:not([hidden])', { timeout: 3000 });
  let saved = await record();
  check(saved.own && saved.mastered === 1 && saved.best === 3 && saved.stars === 3, `${tag}: is mastered with three stars, and saved`, JSON.stringify(saved));

  // ---- and it is still mastered after a reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await page.locator('#spells-status').innerText()) === '1 of 1 word mastered', `${tag}: is still mastered after a reload`,
    await page.locator('#spells-status').innerText());
  await tap(page, '#btn-book');
  check(/Mastered/.test(await page.locator('.book-word[data-word="constructor"] .book-note').innerText()), `${tag}: the spellbook shows it as mastered`);
  await tap(page, '#screen-book [data-go="home"]');
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  let turn = await readTurn(page, [word]);
  check(turn.step === 3 && turn.title === titles[3], `${tag}: comes back for a quick review at step 3 after the reload`, `step ${turn.step}, "${turn.title}"`);
  await tap(page, '#btn-quit');

  // ---- reset wipes it like any other word
  await openParent();
  await page.locator('#btn-reset').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-reset');
  await tap(page, '#btn-reset');
  saved = await record();
  check(!saved.own && saved.stars === 0, `${tag}: reset clears its progress`, JSON.stringify(saved));
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  turn = await readTurn(page, [word]);
  check(turn.step === 1 && turn.title === titles[1], `${tag}: starts again at step 1 after a reset`, `step ${turn.step}, "${turn.title}"`);
  const again = await playTurn(page, [word]);
  check(again.kind === 'success' && (await record()).step === 2, `${tag}: climbs again after a reset`, again.kind);
  check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- a save from before the fix (no record for the word) loads cleanly
  const old = await openPage(browser, baseUrl, SIZES[0], { saved: { words: [word], custom: true, progress: {} }, reducedMotion: 'reduce' });
  await tap(old.page, '#btn-spells');
  await old.page.waitForSelector('#screen-play:not([hidden])');
  turn = await readTurn(old.page, [word]);
  check(turn.step === 1 && turn.title === titles[1], `${tag}: an older save without a record starts at step 1`, `step ${turn.step}, "${turn.title}"`);
  check(old.problems.length === 0, `${tag}: an older save causes no console errors`, old.problems.slice(0, 3).join(' | '));
  await old.context.close();
}

// ---------------------------------------------------------------- review fix 5: no voice on a small iPad

const NO_VOICE_MODES = [
  { name: 'no speech at all', file: 'no-speech', speech: 'none', buttons: 'btn-peek' },
  { name: 'an empty voice list', file: 'no-voices', speech: { voices: [] }, buttons: 'btn-peek' },
  { name: 'a voice that fails', file: 'voice-fails', speech: { error: 'not-allowed' }, buttons: 'btn-hear btn-peek' },
];

// The card's own parts (ladder, title, flashed word, buttons, note) must stay inside it.
async function checkCardHolds(page, label) {
  const report = await page.evaluate(() => {
    const problems = [];
    const card = document.querySelector('#screen-play .prompt-card');
    const box = card.getBoundingClientRect();
    for (const node of card.children) {
      if (node.offsetParent === null) continue;
      const b = node.getBoundingClientRect();
      const name = node.id || node.className;
      if (b.left < box.left - 0.5 || b.right > box.right + 0.5 || b.top < box.top - 0.5 || b.bottom > box.bottom + 0.5) problems.push(`${name} spills out of the card`);
    }
    if (box.top < 0 || box.bottom > window.innerHeight || box.left < 0 || box.right > window.innerWidth) problems.push('the card is off screen');
    const note = card.querySelector('.speech-note');
    if (note.offsetParent !== null && parseFloat(getComputedStyle(note).fontSize) < 16) problems.push('the note is tiny');
    return problems;
  });
  check(report.length === 0, `${label}: the card holds everything in it`, report.slice(0, 3).join('; '));
}

// Step 4 with an apostrophe word is the fullest screen there is (27 letter
// tiles). Without a voice the card also holds Peek and the note, and for a
// moment the flashed word. Checked at every iPad size, in every no-voice state.
async function compactNoVoice(browser, baseUrl) {
  const word = "couldn't";
  const saved = { words: [word], custom: true, progress: { [word]: { step: 4, mastered: 0, best: 0, last: 0 } } };
  for (const size of [...SIZES, ...TIGHT_SIZES]) {
    await Promise.all(NO_VOICE_MODES.map(async (mode) => {
      const tag = `${size.name}, ${mode.name}`;
      const tight = TIGHT_SIZES.includes(size);
      const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: mode.speech, saved, reducedMotion: 'reduce' });

      // ---- home, with its note
      if (mode.buttons === 'btn-peek') {
        await page.waitForSelector('#screen-home [data-speech-note]:not([hidden])', { timeout: 3000 }).catch(() => {});
        const noteFits = await page.evaluate(() => {
          const note = document.querySelector('#screen-home [data-speech-note]');
          if (note.offsetParent === null) return false;
          const box = note.getBoundingClientRect();
          const links = document.querySelector('#screen-home .home-links').getBoundingClientRect();
          return box.top >= links.bottom - 1 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
        });
        check(noteFits, `${tag}: the home note is on screen, under the buttons`);
        await checkHome(page, tag);
        if (tight && mode.speech === 'none') await shot(page, `20-no-voice-${mode.file}-${size.name}-home`);
      }

      // ---- while the word is flashing
      await tap(page, '#btn-spells');
      await page.waitForSelector('#screen-play:not([hidden])');
      const flashed = await page.waitForSelector('#model.is-peek', { state: 'visible', timeout: 3000 }).then(() => true, () => false);
      check(flashed, `${tag}: the word is flashed`);
      await checkPlayLayout(page, `${tag}, while the word flashes`);
      await checkCardHolds(page, `${tag}, while the word flashes`);
      await checkModelFits(page, `${tag}, while the word flashes`, word);
      check(await listenButtons(page) === '', `${tag}: the flashed word takes the place of the buttons`, await listenButtons(page));
      check(await isShowing(page, '#screen-play [data-speech-note]'), `${tag}: the note is shown`);
      const tilesWhileFlashing = await page.locator('#tiles').boundingBox();
      if (tight) await shot(page, `20-no-voice-${mode.file}-${size.name}-flash`);

      // ---- after the flash
      await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
      check(await listenButtons(page) === mode.buttons, `${tag}: only buttons that can do something are shown`, await listenButtons(page));
      await checkPlayLayout(page, `${tag}, after the flash`);
      await checkCardHolds(page, `${tag}, after the flash`);
      const tilesAfter = await page.locator('#tiles').boundingBox();
      check(Math.abs(tilesAfter.y - tilesWhileFlashing.y) < 1, `${tag}: the letter tiles do not move when the flash ends`,
        `${tilesWhileFlashing.y} then ${tilesAfter.y}`);

      // ---- with the whole word typed: Cast must be in reach
      const turn = await readTurn(page, [word]);
      await tapLetters(page, planTaps(turn, false));
      await checkPlayLayout(page, `${tag}, with the word typed`);
      const cast = await page.evaluate(() => {
        const btn = document.querySelector('#btn-cast');
        const box = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 3);
        return { top: box.top, bottom: box.bottom, screen: window.innerHeight, ready: !btn.disabled, reachable: !!hit && btn.contains(hit) };
      });
      check(cast.ready && cast.reachable && cast.top >= 0 && cast.bottom <= cast.screen, `${tag}: all of the Cast button is on screen and can be tapped`,
        `y ${Math.round(cast.top)}–${Math.round(cast.bottom)} of ${cast.screen}`);
      if (tight) await shot(page, `20-no-voice-${mode.file}-${size.name}-typed`);
      const kind = await castAndSeeResult(page);
      check(kind === 'mastered', `${tag}: the word can be mastered`, kind);
      check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 2).join(' | '));
      await context.close();
    }));
  }
}

// ---------------------------------------------------------------- review fix 6: easy skip counting on screen

async function easySkipRound(browser, baseUrl) {
  const tag = 'easy skip counting';
  const topics = Object.fromEntries(ALL_TOPICS.map((id) => [id, id === 'skip']));
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { saved: { math: { level: 'easy', topics, brewed: 0 } }, reducedMotion: 'reduce' });
  await startPotions(page);
  const steps = new Set();
  let turns = 0;
  while (!(await isShowing(page, '#screen-done'))) {
    turns += 1;
    if (turns > 12) throw new Error('The easy skip counting round never finished');
    const seen = await readBrew(page);
    const want = solveBrew(seen);
    const row = seen.sequence.join(', ');
    steps.add(want.numbers[1] - want.numbers[0]);
    check(seen.topic === 'skip' && seen.sequence.length >= 3 && seen.sequence.length <= 5, `${tag}: turn ${turns} is a short row of numbers`, row);
    check(want.numbers.every((n) => n >= 0 && n <= 20), `${tag}: turn ${turns} stays within 20`, row);
    check(seen.sequence.indexOf('?') === seen.sequence.length - 1, `${tag}: turn ${turns} asks what comes next`, row);
    if (turns === 1) {
      await checkPlayLayout(page, tag, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, tag);
    }
    await tapDigits(page, want.digits);
    const kind = await brewAndSeeResult(page);
    check(kind === 'brewed', `${tag}: turn ${turns} brews with the answer ${want.digits}`, kind);
    await tapNext(page);
  }
  check(turns === 8, `${tag}: skip counting alone fills a round of 8`, String(turns));
  check([...steps].every((step) => [2, 5, 10].includes(step)), `${tag}: counts by 2s, 5s or 10s`, [...steps].join(','));
  check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- review fix 7: a save that fails

async function failedSave(browser, browserName, baseUrl) {
  let tag = 'failed save';
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { storage: 'full', reducedMotion: 'reduce' });
  const starter = await page.evaluate(() => window.SPELLCASTER_DATA.starterWords.length);
  const openParent = async (target = page) => {
    await hold(target, browserName, '#btn-parent', 2300);
    await target.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
  };
  const saveWords = async (text, target = page) => {
    await target.locator('#word-input').fill(text);
    await tap(target, '#btn-save-words');
    return (await target.locator('#parent-message').innerText()).trim();
  };
  const goHome = (target = page) => tap(target, '#screen-parent .parent-buttons-end [data-go="home"]');

  // ---- the grown-up is told, and "Saved" is not claimed
  check(!/save|visit/i.test(await page.locator('#screen-home').innerText()), `${tag}: the child's home screen says nothing about saving`);
  await openParent();
  check(await isShowing(page, '#save-note'), `${tag}: the grown-ups' corner says saving is not working, before anything is typed`);
  const noteText = (await page.locator('#save-note').innerText()).replace(/\s+/g, ' ');
  check(/only for this visit/.test(noteText) && /still works/.test(noteText), `${tag}: the notice is clear and gentle`, noteText);
  check(!/error|fail|wrong|!/i.test(noteText), `${tag}: the notice does not alarm`, noteText);
  let message = await saveWords('banana');
  check(!/saved/i.test(message), `${tag}: the message does not claim the word was saved`, message);
  check(/1 word/.test(message) && /this visit only/.test(message), `${tag}: the message says the word works for this visit only`, message);
  check((await readSaved(page)) === null, `${tag}: nothing was written to localStorage`);
  check((await page.locator('#parent-preview .chip').allInnerTexts()).join(',') === 'banana', `${tag}: the list is still used for this visit`);
  check(await isShowing(page, '#save-note'), `${tag}: the notice stays after the failed save`);
  await page.locator('.parent-body').evaluate((node) => { node.scrollTop = 0; });
  await sleep(200);
  await shot(page, '21-failed-save-portrait');
  await tap(page, '#math-level [data-level="easy"]');
  await tap(page, '#round-size [data-size="3"]');
  check(await isShowing(page, '#save-note') && (await readSaved(page)) === null, `${tag}: settings changes keep the notice up`);
  await tap(page, '#btn-starter');
  message = (await page.locator('#parent-message').innerText()).trim();
  check(/this visit only/.test(message), `${tag}: "Use starter list" also says it is for this visit only`, message);
  await saveWords('banana');

  // ---- the game still works for this visit
  await goHome();
  check((await page.locator('#spells-status').innerText()) === '0 of 1 word mastered', `${tag}: the home screen uses the new list`);
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  let result = await playTurn(page, ['banana']);
  check(result.model === 'banana' && result.kind === 'success', `${tag}: the new word can be played`, `${result.model} ${result.kind}`);
  await tapNext(page);
  await tap(page, '#btn-quit');

  // ---- after a reload the list is gone, and the notice says why
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await page.locator('#spells-status').innerText()) === `0 of ${starter} words mastered`, `${tag}: after a reload the starter list is back`,
    await page.locator('#spells-status').innerText());
  await openParent();
  check(await isShowing(page, '#save-note'), `${tag}: the notice is there again after the reload`);
  check((await page.locator('#parent-preview .chip').count()) === starter, `${tag}: the grown-up sees the starter list after the reload`);

  // ---- when saving works again the notice goes away and "Saved" is true
  await page.evaluate(() => { window.__storageFull = false; });
  message = await saveWords('banana');
  check(/^Saved 1 word/.test(message), `${tag}: once saving works the message says "Saved"`, message);
  check(!(await isShowing(page, '#save-note')), `${tag}: once saving works the notice goes away`);
  check(JSON.stringify((await readSaved(page)).words) === '["banana"]', `${tag}: once saving works the word is in localStorage`);

  // ---- storage fills up in the middle of a visit
  await page.evaluate(() => { window.__storageFull = true; });
  await tap(page, '#round-size [data-size="8"]');
  check(await isShowing(page, '#save-note'), `${tag}: the notice appears as soon as a save fails`);
  check((await readSaved(page)).roundSize !== 8, `${tag}: the failed change is not in localStorage`);
  await goHome();
  await startPotions(page);
  const seen = await readBrew(page);
  await tapDigits(page, solveBrew(seen).digits);
  check((await brewAndSeeResult(page)) === 'brewed', `${tag}: potions still brew while saving fails`);
  check((await page.locator('#screen-brew [data-stars]').innerText()).trim() === '2', `${tag}: stars still count for this visit`);
  check(problems.length === 0, `${tag}: no console errors`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- storage switched off completely
  tag = 'blocked storage';
  const blocked = await openPage(browser, baseUrl, SIZES[1], { storage: 'blocked', reducedMotion: 'reduce' });
  await openParent(blocked.page);
  check(await isShowing(blocked.page, '#save-note'), `${tag}: the grown-ups' corner says saving is not working`);
  message = await saveWords('banana', blocked.page);
  check(/this visit only/.test(message) && !/^Saved/.test(message), `${tag}: the message does not claim the word was saved`, message);
  await blocked.page.locator('.parent-body').evaluate((node) => { node.scrollTop = 0; });
  await sleep(200);
  await shot(blocked.page, '21-failed-save-landscape');
  await goHome(blocked.page);
  await tap(blocked.page, '#btn-spells');
  await blocked.page.waitForSelector('#screen-play:not([hidden])');
  result = await playTurn(blocked.page, ['banana']);
  check(result.kind === 'success', `${tag}: the game still plays`, result.kind);
  check(blocked.problems.length === 0, `${tag}: no console errors`, blocked.problems.slice(0, 3).join(' | '));
  await blocked.context.close();
}

// ---------------------------------------------------------------- review fix 8: long words stay in their card

// Twelve letters is the longest word a grown-up can save. The last one is not
// a word, just the widest twelve letters there are.
const LONG_WORDS = ['announcement', 'commonwealth', 'mmmmmmmmwwww'];

async function longWords(browser, baseUrl) {
  for (const size of [...SIZES, ...TIGHT_SIZES]) {
    const tight = TIGHT_SIZES.includes(size);
    await Promise.all(LONG_WORDS.flatMap((word, i) => [
      // ---- the copy step, with and without a voice
      ...['stub', 'none'].map(async (speech) => {
        const tag = `${size.name}, copying${speech === 'none' ? ' without a voice' : ''}`;
        const { context, page, problems } = await openPage(browser, baseUrl, size, { speech, saved: { words: [word], custom: true }, reducedMotion: 'reduce' });
        await tap(page, '#btn-spells');
        await page.waitForSelector('#screen-play:not([hidden])');
        await checkModelFits(page, tag, word);
        const turn = await readTurn(page, [word]);
        await tapLetters(page, planTaps(turn, false));
        await checkPlayLayout(page, `${tag} "${word}"`);
        await checkCardHolds(page, `${tag} "${word}"`);
        check(await listenButtons(page) === (speech === 'none' ? '' : 'btn-hear btn-slow'), `${tag}: the right buttons are under "${word}"`, await listenButtons(page));
        if (tight && i === 0 && speech === 'stub') await shot(page, `22-long-word-${size.name}-copy`);
        check((await castAndSeeResult(page)) === 'success', `${tag}: "${word}" can be copied`);
        check(problems.length === 0, `${tag}: no console errors with "${word}"`, problems.slice(0, 2).join(' | '));
        await context.close();
      }),
      // ---- the peek that stands in for the voice
      (async () => {
        const tag = `${size.name}, peeking`;
        const saved = { words: [word], custom: true, progress: { [word]: { step: 3, mastered: 0, best: 0, last: 0 } } };
        const { context, page, problems } = await openPage(browser, baseUrl, size, { speech: 'none', saved, reducedMotion: 'reduce' });
        await tap(page, '#btn-spells');
        await page.waitForSelector('#screen-play:not([hidden])');
        await page.waitForSelector('#model.is-peek', { state: 'visible', timeout: 3000 }).catch(() => {});
        await checkModelFits(page, tag, word);
        await checkCardHolds(page, `${tag} "${word}"`);
        await checkPlayLayout(page, `${tag} "${word}"`);
        if (tight && i === 1) await shot(page, `22-long-word-${size.name}-peek`);
        check(problems.length === 0, `${tag}: no console errors with "${word}"`, problems.slice(0, 2).join(' | '));
        await context.close();
      })(),
    ]));
  }

  // Turning the iPad while a long word is showing: it is fitted again.
  const word = LONG_WORDS[0];
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1], { saved: { words: [word], custom: true }, reducedMotion: 'reduce' });
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  await checkModelFits(page, 'landscape, before turning', word);
  await page.setViewportSize({ width: TIGHT_SIZES[2].width, height: TIGHT_SIZES[2].height });
  await sleep(300);
  await checkModelFits(page, 'turned to a small portrait', word);
  await page.setViewportSize({ width: SIZES[1].width, height: SIZES[1].height });
  await sleep(300);
  await checkModelFits(page, 'turned back to landscape', word);
  const big = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#model')).fontSize));
  check(big >= 50, 'turned back to landscape: the word grows again when there is room', `${big}px`);
  check(problems.length === 0, 'turning the iPad with a long word: no console errors', problems.slice(0, 2).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- review fix 9: tiles only, no keyboard answers

// A keyboard plugged into the iPad must not be a way to answer: letters and
// numbers go in through the on-screen tiles only. A button that has the focus
// still works the ordinary way (Enter or Space), which is what switch access
// and other assistive tools rely on.
async function keyboardCannotAnswer(browser, baseUrl) {
  // ---- Spells
  let tag = 'spells with a keyboard';
  const spells = await openPage(browser, baseUrl, SIZES[1], { saved: { words: ['cat'], custom: true }, reducedMotion: 'reduce' });
  let page = spells.page;
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  for (const key of ['c', 'a', 't', 'C', 'A', 'T', "'", 'Backspace', 'Enter', ' ']) await page.keyboard.press(key === ' ' ? 'Space' : key);
  let turn = await readTurn(page, ['cat']);
  check(turn.slots.every((slot) => !slot.ch) && turn.tiles.every((tile) => !tile.used), `${tag}: letter keys do not place letters`,
    turn.slots.map((slot) => slot.ch || '_').join(''));
  await tapLetters(page, ['c', 'a']);
  await page.keyboard.press('Backspace');
  turn = await readTurn(page, ['cat']);
  check(turn.slots.map((slot) => slot.ch).join('') === 'ca', `${tag}: Backspace does not undo`, turn.slots.map((slot) => slot.ch || '_').join(''));
  await tapLetters(page, ['t']);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Enter');
  await sleep(400);
  check(!(await isShowing(page, '#result')), `${tag}: Enter does not cast the spell`);
  check((await castAndSeeResult(page)) === 'success', `${tag}: the Cast button still does`);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(420);
  await page.keyboard.press('Enter');
  await sleep(300);
  check(await isShowing(page, '#result'), `${tag}: Enter does not skip the result card`);
  await tapNext(page);
  // Ordinary activation of a focused button is left alone.
  turn = await readTurn(page, ['cat']);
  const firstOpen = turn.slots.findIndex((slot) => !slot.fixed);
  await page.focus(`#tiles .tile:not(:disabled)[data-letter="${'cat'[firstOpen]}"]`);
  await page.keyboard.press('Enter');
  turn = await readTurn(page, ['cat']);
  check(turn.slots[firstOpen].ch === 'cat'[firstOpen], `${tag}: a focused tile still answers to Enter, like any button`, turn.slots.map((slot) => slot.ch || '_').join(''));
  await page.focus('#btn-undo');
  await page.keyboard.press('Space');
  turn = await readTurn(page, ['cat']);
  check(turn.slots.every((slot) => slot.fixed || !slot.ch), `${tag}: a focused Undo button still answers to Space`);
  check(turn.focus !== 'INPUT' && turn.focus !== 'TEXTAREA', `${tag}: no text field is focused`, turn.focus);
  check(spells.problems.length === 0, `${tag}: no console errors`, spells.problems.slice(0, 3).join(' | '));
  await spells.context.close();

  // ---- Potions
  tag = 'potions with a keyboard';
  const potions = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce' });
  page = potions.page;
  await startPotions(page);
  const want = solveBrew(await readBrew(page));
  for (const key of [...want.digits, '9', 'Backspace', 'Enter']) await page.keyboard.press(key);
  await sleep(400);
  check((await readBrew(page)).slots.every((ch) => !ch), `${tag}: number keys do not type an answer`, (await readBrew(page)).slots.join('|'));
  check(!(await isShowing(page, '#result')), `${tag}: Enter does not brew the potion`);
  await tapDigits(page, want.digits);
  await page.keyboard.press('Backspace');
  check((await readBrew(page)).slots.filter((ch) => ch).join('') === want.digits, `${tag}: Backspace does not erase`);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Enter');
  await sleep(400);
  check(!(await isShowing(page, '#result')), `${tag}: Enter does not brew a typed answer either`);
  await page.focus('#btn-brew');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#result:not([hidden])', { timeout: 3000 }).catch(() => {});
  check((await page.getAttribute('#result', 'data-kind')) === 'brewed' && await isShowing(page, '#result'),
    `${tag}: a focused Brew button still answers to Enter, like any button`);
  check(potions.problems.length === 0, `${tag}: no console errors`, potions.problems.slice(0, 3).join(' | '));
  await potions.context.close();
}

// ================================================================ math fluency (MATH-BRIEF.md)
// Ten-frames, the counting-on hint, the Make 10 and Doubles drills, the optional
// speedy brew, and the fact memory with its slow-facts list for grown-ups.

const DAY = 24 * 60 * 60 * 1000;
const DRILLS = ['make10', 'doubles'];
const MAIN_SAVE_KEYS = ['words', 'custom', 'week', 'weekOnly', 'roundSize', 'progress', 'math', 'stars', 'robe', 'familiar', 'chimes'];

// One saved fact for a seeded fact memory. `due` says whether its wait is over.
function savedFact(box, { due = false, miss = false, pace = 'quick', times = [3000], seen = 3, right = 3 } = {}) {
  const now = Date.now();
  const last = due ? now - 40 * DAY : now - 60 * 1000;
  return { box, due: due ? now - DAY : now + 2 * DAY, seen, right, times, last, miss, pace };
}

// The next potion round is made of these recipes, e.g. [['add', 3, 8], ['makeTen', 7]].
async function useRound(page, recipes) {
  await page.evaluate((recipes) => {
    const P = window.SPELLCASTER_POTIONS;
    const round = recipes.map(([name, ...numbers]) => P.build[name](...numbers));
    P.makeRound = () => round;
  }, recipes);
}

// What the help for an addition fact shows right now: the buttons, and the
// ten-frames or the hint under the sum.
async function readHelp(page) {
  return page.evaluate(() => {
    const shown = (node) => !!node && node.offsetParent !== null;
    const helper = document.querySelector('#brew-helper');
    const note = document.querySelector('#brew-note');
    const texts = (sel) => [...helper.querySelectorAll(sel)].map((node) => node.textContent.trim());
    const frames = helper.querySelector('.frames');
    return {
      buttons: ['dots', 'hint'].filter((name) => shown(document.querySelector(`#btn-${name}`))),
      pressed: ['dots', 'hint'].filter((name) => document.querySelector(`#btn-${name}`).getAttribute('aria-pressed') === 'true'),
      open: shown(helper),
      view: shown(helper) ? helper.dataset.view : '',
      // One string per frame, one letter per place: a, b, x (the "1 more" of a near double) or . (empty)
      frames: [...helper.querySelectorAll('.frame')].map((frame) => [...frame.children].map((cell) => {
        const dot = cell.querySelector('.dot');
        return !dot ? '.' : dot.classList.contains('dot-extra') ? 'x' : dot.classList.contains('dot-b') ? 'b' : 'a';
      }).join('')),
      framesLabel: frames ? frames.getAttribute('aria-label') : '',
      caption: texts('.hint-caption').join(' '),
      start: texts('.hop-start').join(' '),
      hops: texts('.hop-dot'),
      steps: texts('.step'),
      seenHops: [...helper.querySelectorAll('.hop')].filter((hop) => Number(getComputedStyle(hop).opacity) > 0.5).length,
      note: shown(note) ? note.textContent.trim() : '',
      mode: document.querySelector('#screen-brew').dataset.mode,
    };
  });
}

// What the help should show, worked out from the sum on screen (never from the game's own data).
function expectHelp(seen) {
  const fill = (text, length) => text.padEnd(length, '.');
  const count = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  const a = parseInt(seen.equation[0], 10);
  if (seen.equation[2] === '?') {
    // Make 10: one frame with what is there; hop up to 10.
    return { frames: [fill('a'.repeat(a), 10)], start: String(a), hops: count(a + 1, 10), steps: [], caption: /up to 10/, say: new RegExp(`Start at ${a} and hop up to 10`) };
  }
  const b = parseInt(seen.equation[2], 10);
  const big = Math.max(a, b);
  const small = Math.min(a, b);
  const all = fill('a'.repeat(a) + 'b'.repeat(b), 20);
  const hops = count(big + 1, a + b - 1).concat('?');
  const counting = { start: String(big), hops, steps: [], caption: a === b ? new RegExp(`Start from ${big}`) : /bigger number/,
    say: new RegExp(`${a === b ? `Start from ${big}` : `Start from the bigger number, ${big}`}\\. Then count on ${small} more\\.`) };
  if (seen.title === 'Make 10 first') {
    const first = 10 - a;
    return { frames: [all.slice(0, 10), all.slice(10)], start: '', hops: [], steps: [`${a} + ${first} = 10`, `10 + ${b - first} = ?`],
      caption: new RegExp(`Make 10 first! ${b} is ${first} and ${b - first}\\.`), say: new RegExp(`${a} plus ${first} makes 10\\. Then add ${b - first} more\\.`) };
  }
  if (seen.title === 'Doubles') return { ...counting, frames: [fill('a'.repeat(a), 10), fill('b'.repeat(b), 10)] };
  if (seen.title === 'Double and 1 more') {
    const one = a > b ? [fill(`${'a'.repeat(a - 1)}x`, 10), fill('b'.repeat(b), 10)] : [fill('a'.repeat(a), 10), fill(`${'b'.repeat(b - 1)}x`, 10)];
    return { frames: one, start: '', hops: [], steps: [`${small} + ${small} = ${2 * small}`, `${2 * small} + 1 = ?`],
      caption: new RegExp(`Use a double! ${small + 1} is ${small} and 1 more\\.`), say: new RegExp(`${small} plus ${small} is ${2 * small}\\. Then add 1 more\\.`) };
  }
  return { ...counting, frames: [all.slice(0, 10), all.slice(10)] };
}

// The ten-frames or the hint must sit between the sum and the help buttons,
// inside the card, in one row, and be big enough to read.
async function checkHelperFits(page, label) {
  const report = await page.evaluate(() => {
    const problems = [];
    const helper = document.querySelector('#brew-helper');
    if (helper.offsetParent === null) return ['the helper is not showing'];
    const card = document.querySelector('#screen-brew .prompt-card').getBoundingClientRect();
    const zone = helper.getBoundingClientRect();
    const sum = document.querySelector('#brew-art .eq').getBoundingClientRect();
    const help = document.querySelector('#brew-help').getBoundingClientRect();
    const listen = [...document.querySelectorAll('#brew-listen:not([hidden]) button')].map((btn) => btn.getBoundingClientRect());
    if (zone.top < sum.bottom - 1) problems.push('the helper overlaps the sum');
    if (zone.bottom > help.top + 1) problems.push('the helper overlaps the help buttons');
    if (sum.left < card.left || sum.right > card.right || parseFloat(getComputedStyle(document.querySelector('#brew-art .eq')).fontSize) < 28) problems.push('the sum is cut off or tiny');
    const parts = [...helper.querySelectorAll('.frame, .cell, .dot, .hint-caption, .hop-start, .hop-dot, .step')];
    if (!parts.length) problems.push('nothing is drawn in the helper');
    for (const node of parts) {
      const b = node.getBoundingClientRect();
      const name = node.className.split(' ')[0];
      if (b.width < 4 || b.height < 4) problems.push(`${name} is too small to see`);
      if (b.left < zone.left - 0.5 || b.right > zone.right + 0.5 || b.top < zone.top - 1.5 || b.bottom > zone.bottom + 1.5) problems.push(`${name} spills out of the helper`);
      if (b.left < card.left || b.right > card.right || b.bottom > card.bottom) problems.push(`${name} spills out of the card`);
      if (listen.some((l) => b.left < l.right && b.right > l.left && b.top < l.bottom && b.bottom > l.top)) problems.push(`a listen button covers ${name}`);
    }
    const tooSmall = (sel, min, what) => {
      const small = [...helper.querySelectorAll(sel)].map((node) => node.getBoundingClientRect()).find((b) => b.width < min || b.height < min);
      if (small) problems.push(`${what} is only ${Math.round(small.width)}x${Math.round(small.height)}px`);
    };
    tooSmall('.dot', 16, 'a dot');
    tooSmall('.hop-dot', 24, 'a hop');
    tooSmall('.hop-start', 36, 'the number to start from');
    for (const node of helper.querySelectorAll('.hint-caption, .hop-dot, .hop-start, .step')) {
      if (parseFloat(getComputedStyle(node).fontSize) < 14) { problems.push(`${node.className.split(' ')[0]} is written tiny`); break; }
    }
    for (const sel of ['.hop-dot', '.step', '.frame']) {
      if (new Set([...helper.querySelectorAll(sel)].map((node) => Math.round(node.getBoundingClientRect().top))).size > 1) problems.push(`${sel} is not in one row`);
    }
    const caption = helper.querySelector('.hint-caption');
    if (caption && caption.scrollWidth > caption.clientWidth + 1) problems.push('the hint words are cut off');
    return [...new Set(problems)];
  });
  check(report.length === 0, `${label}: the helper fits under the sum`, report.slice(0, 4).join('; '));
}

// Where the rows under the card are. Opening the help must not move any of them.
const rowsBelow = (page) => page.evaluate(() => ['#screen-brew .prompt-card', '#brew-slots', '#brew-tiles', '#btn-brew']
  .map((sel) => {
    const box = document.querySelector(sel).getBoundingClientRect();
    return `${Math.round(box.top)}+${Math.round(box.height)}`;
  }).join(' '));

// Solves the potion on screen by tapping. Returns what was seen and how it went.
async function brewOne(page, { miss = false } = {}) {
  const seen = await readBrew(page);
  const want = solveBrew(seen);
  await tapDigits(page, miss ? want.wrong : want.digits);
  const kind = await brewAndSeeResult(page);
  const shown = await page.locator('#result-word').getAttribute('aria-label');
  return { seen, want, kind, shown };
}

// A speedy brew has no result card: after Brew the next potion simply arrives.
async function speedyOne(page, turn, { miss = false, think = 0 } = {}) {
  const seen = await readBrew(page);
  const want = solveBrew(seen);
  if (think) {
    await sleep(60); // the stopwatch leaves out the time the voice is talking, so let it finish first
    await page.evaluate((ms) => window.__wait(ms), think);
  }
  await tapDigits(page, miss ? want.wrong : want.digits);
  await tap(page, '#btn-brew');
  await sleep(120);
  const after = { result: await isShowing(page, '#result'), help: await readHelp(page) };
  await page.waitForFunction((turn) => {
    if (!document.querySelector('#screen-done').hidden) return true;
    const done = document.querySelectorAll('#brew-progress .rp-star.is-done, #brew-progress .rp-star.is-tried').length;
    return done === turn && !document.querySelector('#brew-tiles .tile').disabled && !document.querySelector('#brew-slots .slot.is-filled');
  }, turn, { timeout: 6000 });
  return { seen, want, ...after };
}

// ---------------------------------------------------------------- math scenario: the fact memory and the drill recipes

// Plain functions, so thousands of answers and whole years of waiting take no time.
async function factMemory(browser, baseUrl) {
  const tag = 'fact memory';
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0]);
  const data = await page.evaluate(() => {
    const F = window.SPELLCASTER_FACTS;
    const P = window.SPELLCASTER_POTIONS;
    const MIN = 60 * 1000;
    const DAY = 24 * 60 * MIN;
    const quick = { ok: true, ms: 2500, helped: false };
    const slow = { ok: true, ms: 9000, helped: false };
    const helped = { ok: true, ms: 2500, helped: true };
    const away = { ok: true, ms: NaN, helped: false };
    const miss = { ok: false, ms: 2500, helped: false };
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const t0 = 1700000000000;
    const out = { QUICK_MS: F.QUICK_MS, QUICK_BOX: F.QUICK_BOX, GAPS: F.GAPS };

    // One fact, answered quickly again and again in a single sitting, a minute apart.
    let store = F.fresh();
    out.sitting = [1, 2, 3, 4, 5, 6].map((n) => copy(F.record(store, '8+5', quick, t0 + n * MIN)));
    out.sittingQuick = [F.isQuick(store, '8+5'), F.quickCount(store, ['8+5', '9+4'])];
    // The same fact asked again each time its wait is over: the waits grow.
    store = F.fresh();
    let now = t0;
    out.spaced = [];
    for (let n = 0; n < 7; n++) {
      const f = F.record(store, '8+5', quick, now);
      out.spaced.push({ box: f.box, wait: f.due - now });
      now = f.due + MIN;
    }
    // A known fact that goes wrong: slow, helped, away, missed.
    const known = () => {
      const s = F.fresh();
      let at = t0;
      for (let n = 0; n < 5; n++) at = F.record(s, '7+6', quick, at).due + MIN;
      return { s, at };
    };
    out.after = {};
    for (const [name, answer] of Object.entries({ quick, slow, helped, away, miss })) {
      const { s, at } = known();
      const before = F.get(s, '7+6').box;
      const f = F.record(s, '7+6', answer, at);
      out.after[name] = { before, box: f.box, wait: f.due - at, miss: f.miss, pace: f.pace, times: f.times.length, listed: F.slowList(s).map((row) => `${row.key}:${row.why}:${row.ms}`).join() };
    }
    // A brand new fact answered slowly, with help, or wrong.
    out.first = {};
    for (const [name, answer] of Object.entries({ slow, helped, away, miss })) {
      const s = F.fresh();
      const f = F.record(s, '6+?=10', answer, t0);
      out.first[name] = { box: f.box, wait: f.due - t0, seen: f.seen, right: f.right, times: f.times.length };
    }
    // A slow fact that is then answered quickly leaves the list again.
    store = F.fresh();
    F.record(store, '9+4', slow, t0);
    F.record(store, '9+4', quick, t0 + 20 * MIN);
    out.mended = { listed: F.slowList(store).length, box: F.get(store, '9+4').box };
    // A clock that is set back must not hide a fact for good.
    store = F.fresh();
    for (let n = 0; n < 4; n++) F.record(store, '9+4', quick, t0 + n);
    out.clockBack = F.rank(store, ['9+4', '9+5'], t0 - 400 * DAY);

    // Which facts come first: missed, then due (lowest box first), then new, then the ones that can wait.
    store = F.fresh();
    F.record(store, '9+2', miss, t0);                                  // missed
    F.record(store, '9+3', slow, t0);                                  // due again after ten minutes
    for (let n = 0; n < 2; n++) F.record(store, '9+4', quick, t0);      // box 2: due after a day
    for (let n = 0; n < 3; n++) F.record(store, '9+5', quick, t0);      // box 3: due after three days
    F.record(store, '4+?=10', miss, t0);                                // a make-10 pair, missed
    const keys = ['9+5', '9+6', '9+4', '9+3', '9+2'];
    out.rankSoon = Array.from({ length: 20 }, () => F.rank(store, keys, t0 + MIN).join(' '));
    out.rankLater = F.rank(store, keys, t0 + 2 * DAY).join(' ');
    out.reviewSoon = F.review(store, t0 + MIN, 5);
    out.reviewLater = F.review(store, t0 + 2 * DAY, 5);
    out.reviewOne = F.review(store, t0 + 2 * DAY, 1);
    out.summary = F.summary(store);
    out.slowList = F.slowList(store).map((row) => `${row.key}:${row.why}`);

    // Speedy brews: unlocking sticks, and the best run is kept.
    store = F.fresh();
    out.speedy = [];
    out.speedy.push(F.isUnlocked(store, 'make10'), F.unlock(store, 'make10'), F.unlock(store, 'make10'), F.isUnlocked(store, 'make10'), F.isUnlocked(store, 'doubles'));
    out.runs = [
      F.saveRun(store, 'make10', { right: 6, total: 8, ms: 40000 }),
      F.saveRun(store, 'make10', { right: 6, total: 8, ms: 45000 }), // slower: not a best
      F.saveRun(store, 'make10', { right: 6, total: 8, ms: 30000 }), // faster: a best
      F.saveRun(store, 'make10', { right: 8, total: 8, ms: 90000 }), // more potions: a best, though slower
      F.saveRun(store, 'make10', { right: 7, total: 8, ms: 10000 }), // fewer potions: not a best
    ].map((result) => copy(result));
    out.bestKept = copy(F.speedOf(store, 'make10'));

    // Whatever was saved, the store that comes back is safe to use.
    const good = F.fresh();
    F.record(good, '8+5', quick, t0);
    F.record(good, '7+?=10', miss, t0);
    F.saveRun(good, 'doubles', { right: 8, total: 8, ms: 31000 });
    out.roundTrip = JSON.stringify(F.clean(copy(good))) === JSON.stringify(good);
    const junk = [null, 7, 'facts', [], { facts: 7, speed: 'fast' }, { facts: [1, 2], speed: [3] },
      { facts: { '8+5': null, '9+9': 'yes', '7+7': { seen: 'many' } }, speed: { make10: 7 } }];
    out.junk = junk.map((value) => {
      try {
        const cleaned = F.clean(value);
        return Object.keys(cleaned.facts).length + Object.keys(cleaned.speed).length;
      } catch (err) {
        return `threw ${err.message}`;
      }
    });
    const odd = F.clean(JSON.parse('{"facts":{"constructor":{"seen":2,"box":3},"__proto__":{"seen":2,"box":3},"toString":{"seen":1},"8 + 5":{"seen":1},"123+4":{"seen":1},' +
      '"8+5":{"seen":4,"right":9,"box":99,"due":9e15,"last":1700000000000,"times":[1500,"x",-4,1e9,2000.6],"miss":false,"pace":"zoom"},' +
      '"6+6":{"seen":3,"right":1,"box":4,"miss":true,"pace":"slow","times":"none"},"7+?=10":{"seen":1.9,"right":1,"box":1}},' +
      '"speed":{"make10":{"unlocked":"yes","plays":-2,"best":{"right":12,"total":8,"ms":20000}},"doubles":{"unlocked":true,"plays":3.7,"best":{"right":8,"total":8,"ms":-5}},"Bad Id!":{"unlocked":true}}}'));
    out.odd = copy(odd);
    out.oddProto = Object.getPrototypeOf(odd.facts) === null && Object.getPrototypeOf(odd.speed) === null && F.get(odd, 'constructor') === null && F.get(odd, 'toString') === null;
    const full = F.fresh();
    for (let a = 1; a < 100 && Object.keys(full.facts).length < 500; a++) for (let b = 1; b < 20; b++) F.record(full, `${a}+${b}`, quick, t0);
    out.fullCount = Object.keys(full.facts).length;
    out.badKey = [F.record(F.fresh(), 'constructor', quick, t0), F.record(F.fresh(), '8-5', quick, t0)];

    // The drills and their facts, straight from the recipes.
    out.drills = P.drills.map((drill) => ({ ...drill, ...P.drillFacts(drill.id) }));
    out.topics = P.topics.map((topic) => topic.id);
    out.facts = { within: P.build.add(12, 8).fact, over: P.build.add(12, 9).fact, big: P.build.add(34, 20).fact, sub: P.build.sub(13, 5).fact, story: P.build.story(0, 3, 4).fact, easy: Array.from({ length: 300 }, () => P.makeProblem('add', 'easy')) };
    const only = (ids) => Object.fromEntries(P.topics.map((topic) => [topic.id, ids.includes(topic.id)]));
    const keysOf = (settings, review) => Array.from({ length: 30 }, () => P.makeRound(settings, 8, review).map((problem) => problem.key));
    out.rounds = {
      review: keysOf({ level: 'hundred', topics: only(P.topics.map((topic) => topic.id)) }, [[8, 5]]),
      reviewEasy: keysOf({ level: 'easy', topics: only(['add']) }, [[8, 5], [9, 4], [7, 6]]),
      noAdd: keysOf({ level: 'hundred', topics: only(['sub', 'time']) }, [[8, 5]]),
      plain: keysOf({ level: 'hundred', topics: only(['add', 'sub']) }),
    };
    return out;
  });

  // ---- boxes: quick answers move a fact up, and its wait grows
  check(data.QUICK_MS >= 4000 && data.QUICK_MS <= 8000, `${tag}: a quick answer is one within a few seconds`, String(data.QUICK_MS));
  check(data.GAPS.every((gap, i) => !i || gap > data.GAPS[i - 1]) && data.GAPS[0] === 0 && data.GAPS[2] >= DAY, `${tag}: the waits grow from box to box, from "now" to days`, data.GAPS.join(','));
  check(data.sitting.map((f) => f.box).join() === '1,2,3,3,3,3', `${tag}: three quick answers make a fact quick, and one sitting cannot push it further`, data.sitting.map((f) => f.box).join());
  check(data.sitting[2].due === data.sitting[5].due, `${tag}: asking a quick fact early does not move the day it is due`);
  check(data.sitting[5].seen === 6 && data.sitting[5].right === 6 && data.sitting[5].times.length === 5, `${tag}: answers are counted, and the last five times are kept`, JSON.stringify(data.sitting[5]));
  check(data.sittingQuick.join() === 'true,1', `${tag}: a fact in box ${data.QUICK_BOX} counts as quick`, data.sittingQuick.join());
  check(data.spaced.map((s) => s.box).join() === '1,2,3,4,5,5,5', `${tag}: a fact asked when it is due climbs to the top box`, data.spaced.map((s) => s.box).join());
  check(data.spaced.slice(0, 5).every((s, i) => s.wait === data.GAPS[i + 1]), `${tag}: each box waits longer than the one before (growing intervals)`, data.spaced.map((s) => Math.round(s.wait / 60000)).join(' min, '));

  // ---- slow, helped and missed facts come back sooner
  const { after, first } = data;
  check(after.quick.box === after.quick.before && after.quick.listed === '', `${tag}: a quick answer keeps a known fact in the top box and off the slow list`, JSON.stringify(after.quick));
  check(after.slow.box === after.slow.before - 1 && after.slow.wait === data.GAPS[1], `${tag}: a slow answer costs one box and brings the fact back soon`, JSON.stringify(after.slow));
  check(after.slow.listed === '7+6:slow:9000', `${tag}: a slow fact is listed with the time it took`, after.slow.listed);
  check(after.helped.box === 1 && after.helped.wait === data.GAPS[1] && after.helped.listed === '7+6:helped:null', `${tag}: an answer that needed the dots or the hint goes back to box 1 and is listed`, JSON.stringify(after.helped));
  check(first.helped.times === 0 && first.away.times === 0 && first.slow.times === 1, `${tag}: only an answer without help is kept as a recall time`, JSON.stringify(first));
  check(after.away.box === after.away.before && after.away.listed === '' && after.away.pace === 'quick' && after.away.wait === -60000,
    `${tag}: an answer nobody could time changes nothing: not the box, not the day it is due, not what it was last time`, JSON.stringify(after.away));
  check(after.miss.box === 0 && after.miss.wait === 0 && after.miss.miss === true && after.miss.listed === '7+6:missed:null', `${tag}: a missed fact drops to box 0, is due at once and is listed`, JSON.stringify(after.miss));
  check(first.slow.box === 1 && first.helped.box === 1 && first.away.box === 1 && first.miss.box === 0, `${tag}: a new fact starts in box 1 when right and box 0 when missed`, JSON.stringify(first));
  check(first.miss.seen === 1 && first.miss.right === 0 && first.slow.right === 1, `${tag}: right and wrong answers are counted apart`, JSON.stringify(first));
  check(data.mended.listed === 0 && data.mended.box === 2, `${tag}: a slow fact that is then answered quickly leaves the slow list`, JSON.stringify(data.mended));
  check(data.clockBack[0] === '9+4', `${tag}: a clock set back does not hide a fact for good`, data.clockBack.join(' '));

  // ---- which facts come first
  check(new Set(data.rankSoon).size === 1 && data.rankSoon[0] === '9+2 9+6 9+3 9+4 9+5', `${tag}: missed facts come first, then new ones, then the ones that can wait`, data.rankSoon[0]);
  check(data.rankLater === '9+2 9+3 9+4 9+6 9+5', `${tag}: once their wait is over, facts come before new ones, lowest box first`, data.rankLater);
  check(JSON.stringify(data.reviewSoon) === '[[9,2]]', `${tag}: a mixed round reviews missed facts at once`, JSON.stringify(data.reviewSoon));
  check(JSON.stringify(data.reviewLater) === '[[9,2],[9,3],[9,4]]', `${tag}: ... then slow facts and the others whose wait is over, but never one that can still wait, or a make-10 pair`, JSON.stringify(data.reviewLater));
  check(JSON.stringify(data.reviewOne) === '[[9,2]]', `${tag}: the review list keeps to its limit, most in need first`, JSON.stringify(data.reviewOne));
  check(data.summary.practiced === 5 && data.summary.quick === 1 && data.summary.slow === 3, `${tag}: the summary counts practiced, quick and slow facts`, JSON.stringify(data.summary));
  check(data.slowList.join() === '9+2:missed,4+?=10:missed,9+3:slow' || data.slowList.join() === '4+?=10:missed,9+2:missed,9+3:slow', `${tag}: the slow list puts missed facts first`, data.slowList.join());

  // ---- speedy brews
  check(data.speedy.join() === 'false,true,false,true,false', `${tag}: a speedy brew is unlocked once, for its own drill only`, data.speedy.join());
  check(data.runs.map((run) => run.best).join() === 'true,false,true,true,false', `${tag}: more potions beat fewer, and the same number faster is a new best`, data.runs.map((run) => run.best).join());
  check(data.runs[0].previous === null && data.runs[1].previous.ms === 40000, `${tag}: a run is told what the best was before`, JSON.stringify(data.runs.slice(0, 2)));
  check(data.bestKept.unlocked && data.bestKept.plays === 5 && data.bestKept.best.right === 8 && data.bestKept.best.ms === 90000, `${tag}: the best run and the number of runs are kept`, JSON.stringify(data.bestKept));

  // ---- damaged saves
  check(data.roundTrip, `${tag}: a saved fact memory comes back exactly as it was`);
  check(data.junk.every((count) => count === 0), `${tag}: a damaged fact memory becomes an empty one, without an error`, data.junk.join(','));
  check(Object.keys(data.odd.facts).sort().join() === '6+6,7+?=10,8+5' && data.oddProto, `${tag}: only real fact names are kept from a save ("constructor" is not one)`, Object.keys(data.odd.facts).join());
  const mended = data.odd.facts['8+5'];
  check(mended.box === 5 && mended.right === 4 && mended.seen === 4 && mended.times.join() === '1500,2001' && mended.pace === 'away' && mended.due <= mended.last + data.GAPS[5],
    `${tag}: odd numbers in a save are brought back into range`, JSON.stringify(mended));
  check(data.odd.facts['6+6'].box === 0 && data.odd.facts['6+6'].times.length === 0 && data.odd.facts['7+?=10'].seen === 1, `${tag}: a missed fact is always in box 0`, JSON.stringify(data.odd.facts['6+6']));
  check(Object.keys(data.odd.speed).sort().join() === 'doubles,make10' && data.odd.speed.make10.unlocked === false && data.odd.speed.make10.plays === 0 &&
    data.odd.speed.make10.best.right === 8 && data.odd.speed.doubles.best === null && data.odd.speed.doubles.plays === 3,
    `${tag}: odd speedy records are mended or dropped`, JSON.stringify(data.odd.speed));
  check(data.fullCount <= 400, `${tag}: the fact memory cannot grow without end`, String(data.fullCount));
  check(data.badKey.every((value) => value === null), `${tag}: something that is not an addition fact is never written down`);

  // ---- the drills and their recipes
  check(data.drills.map((drill) => drill.id).join() === DRILLS.join(), `${tag}: the drills are Make 10 and Doubles`, data.drills.map((drill) => drill.id).join());
  check(data.drills.every((drill) => drill.name && drill.icon && drill.teaser && /^#[0-9a-f]{6}$/.test(drill.color)), `${tag}: every drill has a name, an icon and a potion color`);
  check(JSON.stringify(data.topics) === JSON.stringify(ALL_TOPICS), `${tag}: drills are not topics (grown-ups do not switch them on or off)`, data.topics.join());
  for (const drill of data.drills) {
    const bad = [];
    const note = (problem, why) => { if (bad.length < 3) bad.push(`${problem.key}: ${why}`); };
    const all = drill.core.concat(drill.stretch);
    for (const problem of all) {
      const want = solveBrew(asSeen(problem));
      const { fact } = problem;
      if (problem.topic !== drill.id) note(problem, 'wrong drill');
      if (want.digits !== problem.answer) note(problem, `answer ${problem.answer}, but the screen says ${want.digits}`);
      if (!want.solved.test(problem.solved.join(''))) note(problem, `result card shows "${problem.solved.join('')}"`);
      if (problem.solved[1] !== problem.answer) note(problem, 'the answer does not stand out on the result card');
      if (!problem.title || problem.title.length > 26 || !problem.say || problem.say.length < 12 || !problem.sayAnswer) note(problem, 'title or words missing');
      if (!problem.label || problem.label.length > 30 || !problem.label.endsWith(` = ${problem.show.parts[4] === '10' ? '10' : problem.answer}`)) note(problem, `label "${problem.label}"`);
      if (!fact || fact.a < 1 || fact.b < 1 || fact.a + fact.b > 20) note(problem, 'not an addition fact within 20');
      if (fact && fact.a + fact.b !== want.numbers[2] && fact.a + fact.b !== Number(want.digits)) note(problem, 'the fact does not match the sum');
    }
    check(bad.length === 0, `${tag}: all ${all.length} ${drill.name} facts are correct, within 20 and well worded`, bad.join(' | '));
    check(new Set(all.map((problem) => problem.key)).size === all.length && new Set(all.map((problem) => problem.fact.key)).size === all.length, `${tag}: no ${drill.name} fact is there twice`);
  }
  const [make10, doubles] = data.drills;
  check(make10.core.length === 9 && make10.core.every((p, i) => p.show.parts.join(' ') === `${i + 1} + ? = 10` && p.fact.key === `${i + 1}+?=10` && p.fact.hint === 'ten' && /^What goes with \d to make 10\?$/.test(p.say)),
    `${tag}: Make 10 asks what goes with 1 to 9 to make 10`, make10.core.map((p) => p.show.parts.join('')).join(' '));
  check(make10.stretch.length >= 12 && make10.stretch.every((p) => p.fact.a < 10 && p.fact.a > p.fact.b && p.fact.a + p.fact.b > 10 && p.fact.hint === 'bridge' && p.fact.key === `${p.fact.a}+${p.fact.b}`),
    `${tag}: ... then sums that bridge through 10, bigger number first`, make10.stretch.map((p) => p.fact.key).join(' '));
  const eightFive = make10.stretch.find((p) => p.fact.key === '8+5');
  check(!!eightFive && eightFive.solved.join('') === '8 + 5 = 8 + 2 + 3 = 13' && eightFive.label === '8 + 5 = 13', `${tag}: 8 + 5 is shown as 8 + 2 + 3`, eightFive && eightFive.solved.join(''));
  check(doubles.core.length === 10 && doubles.core.every((p, i) => p.fact.a === i + 1 && p.fact.b === i + 1 && p.fact.pair === true && p.fact.hint === 'count'),
    `${tag}: Doubles asks 1 + 1 up to 10 + 10`, doubles.core.map((p) => p.fact.key).join(' '));
  check(doubles.stretch.length >= 12 && doubles.stretch.every((p) => Math.abs(p.fact.a - p.fact.b) === 1 && p.fact.hint === 'near' && p.fact.pair === true) &&
    doubles.stretch.some((p) => p.fact.a > p.fact.b) && doubles.stretch.some((p) => p.fact.a < p.fact.b),
    `${tag}: ... then near doubles, both ways round`, doubles.stretch.map((p) => p.fact.key).join(' '));
  const sixSeven = doubles.stretch.find((p) => p.fact.key === '6+7');
  check(!!sixSeven && sixSeven.solved.join('') === '6 + 7 = 6 + 6 + 1 = 13', `${tag}: 6 + 7 is shown as 6 + 6 + 1`, sixSeven && sixSeven.solved.join(''));

  // ---- which potions are addition facts
  const { facts, rounds } = data;
  check(facts.within && facts.within.key === '12+8' && facts.within.hint === 'count' && facts.over === null && facts.big === null, `${tag}: a sum is a fact when it stays within 20`, JSON.stringify([facts.within, facts.over, facts.big]));
  check(facts.sub === null && facts.story === null, `${tag}: taking away and stories are not tracked as addition facts`);
  check(facts.easy.every((p) => p.fact && p.fact.key === `${p.fact.a}+${p.fact.b}` && p.fact.a + p.fact.b === Number(p.answer)), `${tag}: every easy sum is an addition fact with its own name`);
  check(rounds.review.every((round) => round.includes('add:8+5') && round.length === 8 && new Set(round).size === 8), `${tag}: a fact that is due takes the place of a fresh sum in a mixed round`, rounds.review[0].join(' '));
  check(rounds.reviewEasy.every((round) => ['add:8+5', 'add:9+4', 'add:7+6'].every((key) => round.includes(key)) && new Set(round).size === 8), `${tag}: several due facts fit into a round of sums`);
  check(rounds.noAdd.every((round) => !round.includes('add:8+5') && round.every((key) => /^(sub|time):/.test(key))), `${tag}: with Adding switched off, no addition fact is slipped in`, rounds.noAdd[0].join(' '));
  check(rounds.plain.every((round) => round.length === 8 && new Set(round).size === 8), `${tag}: without anything to review a round is as before`);
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- math scenario: ten-frames and the counting-on hint

// One addition fact of every kind, and for each the dots and the hint.
const HELP_ROUND = [['add', 3, 8], ['add', 12, 5], ['add', 9, 1], ['add', 10, 10], ['bridge', 8, 5], ['double', 6], ['nearDouble', 6, 7], ['nearDouble', 10, 9], ['makeTen', 7], ['makeTen', 1]];
// The ones that are hardest to fit: ten hops, nine hops, and the two rows of little sums.
const HELP_ROUND_SHORT = [['add', 10, 10], ['bridge', 8, 5], ['nearDouble', 10, 9], ['makeTen', 1]];
const HELP_SHOTS = { '3 + 8': 'count-on', '8 + 5': 'make-10-first', '6 + 7': 'near-double', '7 + ?': 'make-10', '6 + 6': 'double' };

async function factHelpers(browser, baseUrl) {
  // ---- every kind of fact on the biggest and the smallest screen, the trickiest
  // ones at every iPad size (still pictures, so it is quick)
  for (const size of [...SIZES, ...TIGHT_SIZES]) {
    const tag = `fact help ${size.name}`;
    const recipes = size === SIZES[0] || size === TIGHT_SIZES[3] ? HELP_ROUND : HELP_ROUND_SHORT;
    const { context, page, problems } = await openPage(browser, baseUrl, size, { reducedMotion: 'reduce' });
    await useRound(page, recipes);
    await startPotions(page);
    for (let turn = 1; turn <= recipes.length; turn++) {
      const seen = await readBrew(page);
      const sum = seen.equation.join(' ');
      const what = `${tag}, ${sum.replace(' = ?', '')}`;
      const want = expectHelp(seen);
      const answer = solveBrew(seen).digits;
      let help = await readHelp(page);
      check(help.buttons.join() === 'dots,hint' && help.pressed.length === 0 && !help.open, `${what}: Dots and Hint are offered, and nothing is showing yet`, JSON.stringify(help.buttons));
      await checkPlayLayout(page, `${what} (help closed)`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${what} (help closed)`);
      const before = await rowsBelow(page);
      const spokenBefore = (await spokenList(page)).length;

      // ---- the dots: ten-frames, one color for each number
      await tap(page, '#btn-dots');
      help = await readHelp(page);
      check(help.open && help.view === 'dots' && help.pressed.join() === 'dots', `${what}: tapping Dots shows the ten-frames`, `${help.view} / ${help.pressed.join()}`);
      check(help.frames.join(' ') === want.frames.join(' '), `${what}: the dots show each number in its own color`, `${help.frames.join(' ')} — wanted ${want.frames.join(' ')}`);
      check(help.frames.every((frame) => frame.length === 10), `${what}: every frame has ten places`);
      check(/dot/.test(help.framesLabel), `${what}: the ten-frames are described for a screen reader`, help.framesLabel);
      check((await rowsBelow(page)) === before, `${what}: opening the dots moves nothing below the card`, `${before} -> ${await rowsBelow(page)}`);
      check((await spokenList(page)).length === spokenBefore, `${what}: the dots open quietly`);
      await checkHelperFits(page, `${what} (dots)`);
      await checkPlayLayout(page, `${what} (dots)`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${what} (dots)`);
      const shotName = Object.keys(HELP_SHOTS).find((start) => sum.startsWith(start));
      if (shotName) await shot(page, `22-facts-dots-${HELP_SHOTS[shotName]}-${size.name}`);

      // ---- the hint: a strategy, with the last step left for the child
      await tap(page, '#btn-hint');
      help = await readHelp(page);
      check(help.open && help.view === 'hint' && help.pressed.join() === 'hint' && help.frames.length === 0, `${what}: tapping Hint swaps the dots for the hint`, `${help.view} / ${help.pressed.join()}`);
      check(help.start === want.start && help.hops.join() === want.hops.join(), `${what}: the hint starts at the right number and hops dot by dot`, `start ${help.start}, hops ${help.hops.join()} — wanted ${want.start}, ${want.hops.join()}`);
      check(help.steps.join(' | ') === want.steps.join(' | '), `${what}: the hint shows the right little sums`, help.steps.join(' | '));
      check(want.caption.test(help.caption), `${what}: the hint says what to do`, help.caption);
      if (seen.equation[2] !== '?') {
        check(!help.hops.includes(answer) && !help.steps.some((step) => step.endsWith(`= ${answer}`)) && !help.caption.includes(answer), `${what}: the hint leaves the answer to the child`, `${help.hops.join()} ${help.steps.join()}`);
      }
      const said = (await spokenList(page)).pop();
      check(want.say.test(said.text) && Math.abs(said.rate - 0.85) < 0.01, `${what}: the hint is read aloud`, said.text);
      check(help.seenHops === help.hops.length, `${what}: with reduced motion every hop is there at once`, `${help.seenHops} of ${help.hops.length}`);
      check((await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)) === 0, `${what}: with reduced motion nothing in the hint moves`);
      check((await rowsBelow(page)) === before, `${what}: opening the hint moves nothing below the card`, `${before} -> ${await rowsBelow(page)}`);
      await checkHelperFits(page, `${what} (hint)`);
      await checkPlayLayout(page, `${what} (hint)`, '#screen-brew', BREW_ROWS);
      await checkBrewPicture(page, `${what} (hint)`);
      if (shotName) await shot(page, `22-facts-hint-${HELP_SHOTS[shotName]}-${size.name}`);

      // ---- tapping it again puts it away
      await tap(page, '#btn-hint');
      help = await readHelp(page);
      check(!help.open && help.pressed.length === 0, `${what}: tapping Hint again puts it away`);
      check((await rowsBelow(page)) === before, `${what}: closing the help moves nothing either`);

      await tapDigits(page, answer);
      const kind = await brewAndSeeResult(page);
      check(kind === 'brewed', `${what}: the potion brews with ${answer}`, kind);
      await tapNext(page);
    }
    await page.waitForSelector('#screen-done:not([hidden])');
    const facts = (await readFacts(page)).facts;
    check(Object.keys(facts).length === recipes.length && Object.values(facts).every((f) => f.pace === 'helped' && f.box === 1 && f.seen === 1 && f.right === 1 && f.times.length === 0),
      `${tag}: answers given with the dots or the hint open are remembered as helped, not as quick`, JSON.stringify(Object.values(facts).map((f) => f.pace)));
    check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
    await context.close();
  }

  // ---- with motion: the hint hops on dot by dot, and a missed fact comes back with its dots
  const tag = 'fact help in play';
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1]);
  await useRound(page, [['add', 3, 8], ['sub', 15, 7], ['add', 34, 20], ['add', 9, 4], ['blocks', 17], ['makeTen', 6]]);
  await startPotions(page);
  let seen = await readBrew(page);
  check(seen.equation.join(' ') === '3 + 8 = ?', `${tag}: the round starts with 3 + 8`, seen.equation.join(' '));
  await tap(page, '#btn-hint');
  await sleep(150);
  let help = await readHelp(page);
  check(help.hops.join() === '9,10,?' && help.start === '8', `${tag}: for 3 + 8 the hint starts from 8, the bigger number`, `${help.start}: ${help.hops.join()}`);
  check(help.seenHops < 3, `${tag}: the hops come one after the other, not all at once`, `${help.seenHops} of 3 showing after a moment`);
  await sleep(2200);
  help = await readHelp(page);
  check(help.seenHops === 3, `${tag}: in the end every hop is showing`, String(help.seenHops));
  await checkHelperFits(page, `${tag} (hint, after the hops)`);
  await tap(page, '#btn-dots');
  await sleep(700);
  help = await readHelp(page);
  check(help.view === 'dots' && help.frames.join(' ') === 'aaabbbbbbb b.........', `${tag}: 3 + 8 fills the first frame and puts 1 in the second`, help.frames.join(' '));
  await shot(page, '22-facts-dots-count-on-landscape-in-play');

  // Missed on purpose. The fizzle card is as gentle as ever.
  await tapDigits(page, '12');
  let kind = await brewAndSeeResult(page);
  check(kind === 'fizzle', `${tag}: a wrong answer gently fizzles`, kind);
  check((await page.locator('#result-word').getAttribute('aria-label')) === '3 + 8 = 11', `${tag}: the fizzle card shows the finished sum`);
  let facts = (await readFacts(page)).facts;
  check(facts['3+8'] && facts['3+8'].miss === true && facts['3+8'].box === 0 && facts['3+8'].right === 0, `${tag}: the miss is written into the fact memory`, JSON.stringify(facts['3+8']));
  await tapNext(page);

  // Potions that are not addition facts have no help row.
  for (const [sum, why] of [['15 − 7 = ?', 'taking away'], ['34 + 20 = ?', 'a sum past 20']]) {
    seen = await readBrew(page);
    help = await readHelp(page);
    check(seen.equation.join(' ') === sum && help.buttons.length === 0 && !help.open, `${tag}: ${why} has no Dots or Hint button`, `${seen.equation.join(' ')}: ${help.buttons.join()}`);
    await checkBrewPicture(page, `${tag} (${why})`);
    check((await brewOne(page)).kind === 'brewed', `${tag}: ${why} still brews`);
    await tapNext(page);
  }
  seen = await readBrew(page);
  help = await readHelp(page);
  check(seen.equation.join(' ') === '9 + 4 = ?' && help.buttons.join() === 'dots,hint' && !help.open, `${tag}: a fact that was never missed starts with its help closed`, JSON.stringify(help.buttons));
  check((await brewOne(page)).kind === 'brewed', `${tag}: 9 + 4 brews without help`);
  await tapNext(page);

  // Three other potions later the missed fact is back, with its dots already showing.
  seen = await readBrew(page);
  help = await readHelp(page);
  check(seen.equation.join(' ') === '3 + 8 = ?', `${tag}: the missed fact comes back a few turns later`, seen.equation.join(' '));
  check(help.open && help.view === 'dots' && help.pressed.join() === 'dots' && help.frames.join(' ') === 'aaabbbbbbb b.........', `${tag}: after a miss the dots show by themselves`, `${help.view} ${help.frames.join(' ')}`);
  await sleep(800); // the dots pop in one after the other
  await checkHelperFits(page, `${tag} (dots after a miss)`);
  await shot(page, '22-facts-dots-after-a-miss-landscape');
  const back = await brewOne(page);
  check(back.kind === 'brewed' && (await page.locator('#result-stars .big-star.is-won').count()) === 1, `${tag}: the fact brews on the second try, for 1 star`, back.kind);
  await tapNext(page);
  seen = await readBrew(page);
  help = await readHelp(page);
  check(seen.show === 'blocks' && help.buttons.length === 0, `${tag}: tens and ones have no help row`, seen.show);
  check((await brewOne(page)).kind === 'brewed', `${tag}: tens and ones still brew`);
  await tapNext(page);
  check((await brewOne(page)).kind === 'brewed', `${tag}: the make-10 potion brews`);
  await tapNext(page);
  await page.waitForSelector('#screen-done:not([hidden])');
  facts = (await readFacts(page)).facts;
  check(Object.keys(facts).sort().join() === '3+8,6+?=10,9+4', `${tag}: only addition facts are written into the fact memory`, Object.keys(facts).join());
  check(facts['3+8'].seen === 2 && facts['3+8'].right === 1 && facts['3+8'].miss === false && facts['3+8'].pace === 'helped' && facts['3+8'].box === 1,
    `${tag}: the second try counts as right with help`, JSON.stringify(facts['3+8']));
  check(facts['9+4'].pace === 'quick' && facts['9+4'].box === 1 && facts['9+4'].times.length === 1 && facts['9+4'].times[0] < 6000, `${tag}: a quick answer without help is timed`, JSON.stringify(facts['9+4']));
  const saved = await readSaved(page);
  check(JSON.stringify(Object.keys(saved)) === JSON.stringify(MAIN_SAVE_KEYS) && !('facts' in saved.math), `${tag}: the game save keeps its old shape (facts live under their own key)`, Object.keys(saved).join());
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- a fact that was missed on another day also comes back with its dots, in a mixed round of sums
  const later = await openPage(browser, baseUrl, SIZES[0], {
    reducedMotion: 'reduce',
    saved: { math: { level: 'easy', topics: Object.fromEntries(ALL_TOPICS.map((id) => [id, id === 'add'])), brewed: 3 } },
    savedFacts: { facts: { '8+5': savedFact(0, { due: true, miss: true, seen: 2, right: 1 }), '7+6': savedFact(1, { due: true, pace: 'slow', times: [9000] }), '9+9': savedFact(4, { due: true }), '3+?=10': savedFact(0, { due: true, miss: true }) }, speed: {} },
  });
  await startPotions(later.page);
  const round = [];
  let dotsShown = '';
  for (let turn = 1; turn <= 8; turn++) {
    seen = await readBrew(later.page);
    round.push(seen.equation.join(' '));
    if (seen.equation.join(' ') === '8 + 5 = ?') dotsShown = (await readHelp(later.page)).view;
    await brewOne(later.page);
    await tapNext(later.page);
  }
  check(round.includes('8 + 5 = ?') && round.includes('7 + 6 = ?'), 'spaced repeats: slow and missed facts from another day come back in the next round of sums', round.join(' | '));
  check(round[0] === '8 + 5 = ?' && round[1] === '7 + 6 = ?', 'spaced repeats: the missed fact comes first, then the slow one', round.slice(0, 2).join(' | '));
  check(round[2] === '9 + 9 = ?', 'spaced repeats: a quick fact whose day has come is asked again too, after the ones that need work', round[2]);
  check(!round.some((sum) => sum.includes('? = 10')), 'spaced repeats: a make-10 pair waits for its own drill', round.join(' | '));
  check(dotsShown === 'dots', 'spaced repeats: a fact missed on another day opens with its dots', dotsShown);
  check(new Set(round).size === 8 && round.every((sum) => /^\d+ \+ \d+ = \?$/.test(sum)), 'spaced repeats: the rest of the round is fresh sums', round.join(' | '));
  check(later.problems.length === 0, 'spaced repeats: no errors in the browser console', later.problems.slice(0, 3).join(' | '));
  await later.context.close();
}

// ---------------------------------------------------------------- math scenario: the Potions menu and its drills

// The Potions menu: three big cards, everything on screen, nothing overlapping.
async function checkMenu(page, label, speedy = []) {
  const menu = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#screen-potions .menu-card')].filter((node) => node.offsetParent !== null).map((node) => {
      const box = node.getBoundingClientRect();
      return { id: node.id, text: node.innerText.replace(/\s+/g, ' ').trim(), left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    });
    const witch = document.querySelector('#screen-potions .witch').getBoundingClientRect();
    const home = document.querySelector('#screen-potions [data-go="home"]').getBoundingClientRect();
    const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    return {
      cards,
      onScreen: cards.concat([witch, home]).every((b) => b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight),
      apart: cards.every((a, i) => cards.every((b, j) => i === j || !overlap(a, b))) && cards.every((card) => !overlap(card, witch) && !overlap(card, home)),
      inputs: [...document.querySelectorAll('input, textarea')].filter((node) => node.offsetParent !== null).length,
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  const want = ['btn-mix', 'btn-drill-make10', ...(speedy.includes('make10') ? ['btn-speedy-make10'] : []), 'btn-drill-doubles', ...(speedy.includes('doubles') ? ['btn-speedy-doubles'] : [])];
  check(menu.cards.map((card) => card.id).join() === want.join(), `${label}: the menu offers ${want.length} potions to choose from`, menu.cards.map((card) => card.id).join());
  check(menu.cards.every((card) => card.height >= MIN_TAP && card.width >= 200), `${label}: every menu card is big enough for small fingers`,
    menu.cards.map((card) => `${Math.round(card.width)}x${Math.round(card.height)}`).join(', '));
  check(menu.onScreen && menu.apart && !menu.sideways, `${label}: the menu fits on the iPad and nothing overlaps`, `on screen ${menu.onScreen}, apart ${menu.apart}`);
  check(menu.inputs === 0, `${label}: the menu has no text field`);
  return menu.cards;
}

async function factDrills(browser, baseUrl) {
  for (const size of SIZES) {
    const tag = `drills ${size.name}`;
    const { context, page, problems } = await openPage(browser, baseUrl, size, { reducedMotion: size === SIZES[0] ? 'no-preference' : 'reduce', saved: { stars: 2 } });

    // ---- the menu
    await tap(page, '#btn-potions');
    await page.waitForSelector('#screen-potions:not([hidden])');
    check(!(await isShowing(page, '#screen-brew')), `${tag}: the Potions button opens the potion menu first`);
    let spoken = await spokenList(page);
    check(spoken.length === 1 && /potion/i.test(spoken[0].text), `${tag}: the menu greets with the voice (the tap unlocks speech)`, spoken.map((s) => s.text).join(' | '));
    await sleep(500);
    let cards = await checkMenu(page, tag);
    check(/Mixed potions/.test(cards[0].text) && /Make 10/.test(cards[1].text) && /Doubles/.test(cards[2].text), `${tag}: Mixed potions, Make 10 and Doubles can be chosen`, cards.map((card) => card.text).join(' | '));
    check(!(await isShowing(page, '#btn-speedy-make10')) && !(await isShowing(page, '#btn-speedy-doubles')), `${tag}: no speedy brew is offered before the facts are quick`);
    await shot(page, `23-potions-menu-${size.name}`);
    await tap(page, '#screen-potions [data-go="home"]');
    await page.waitForSelector('#screen-home:not([hidden])');
    check(true, `${tag}: the home button leaves the menu`);

    // ---- both drills, one round each
    let stars = 2;
    let brewed = 0;
    for (const drill of DRILLS) {
      const name = drill === 'make10' ? 'Make 10' : 'Doubles';
      await startPotions(page, `#btn-drill-${drill}`);
      check((await page.locator('#brew-progress .rp-star').count()) === 8, `${tag}: a ${name} round has 8 potions`);
      spoken = await spokenList(page);
      check(/\?/.test(spoken[spoken.length - 1].text) && spoken[spoken.length - 1].text.length > 12, `${tag}: the first ${name} potion is read aloud`, spoken[spoken.length - 1].text);
      const sums = [];
      const kinds = [];
      for (let turn = 1; turn <= 8; turn++) {
        const seen = await readBrew(page);
        const help = await readHelp(page);
        const sum = seen.equation.join(' ');
        const [a, , b] = seen.equation.map((part) => parseInt(part, 10));
        sums.push(sum);
        const kindOf = seen.equation[2] === '?' ? 'pair' : a === b ? 'double' : Math.abs(a - b) === 1 && drill === 'doubles' ? 'near' : 'bridge';
        kinds.push(kindOf);
        check(seen.topic === drill && help.mode === 'drill', `${tag}: ${name} turn ${turn} belongs to the drill`, `${seen.topic} ${help.mode}`);
        check(help.buttons.join() === 'dots,hint', `${tag}: ${name} turn ${turn} offers Dots and Hint`);
        check(solveBrew(seen).numbers.every((n) => n >= 0 && n <= 20), `${tag}: ${name} turn ${turn} stays within 20`, sum);
        check(seen.focus !== 'INPUT' && seen.focus !== 'TEXTAREA', `${tag}: no text field is focused in a drill`, seen.focus);
        if (kindOf === 'pair') check(seen.title === 'Make 10' && seen.equation[4] === '10', `${tag}: "${sum}" asks what makes 10`, seen.title);
        if (kindOf === 'bridge') check(seen.title === 'Make 10 first' && a < 10 && a > b && a + b > 10, `${tag}: "${sum}" bridges through 10, bigger number first`, seen.title);
        if (kindOf === 'double') check(seen.title === 'Doubles', `${tag}: "${sum}" is a double`, seen.title);
        if (kindOf === 'near') check(seen.title === 'Double and 1 more', `${tag}: "${sum}" is a near double`, seen.title);
        if (turn === 1 || turn === 8) {
          await checkPlayLayout(page, `${tag} ${name} turn ${turn}`, '#screen-brew', BREW_ROWS);
          await checkBrewPicture(page, `${tag} ${name} turn ${turn}`);
          await tapDigits(page, solveBrew(seen).digits);
          await sleep(350);
          await shot(page, `24-drill-${drill}-${turn === 1 ? 'first' : 'last'}-${size.name}`);
          for (let i = 0; i < solveBrew(seen).digits.length; i++) await tap(page, '#btn-brew-undo');
          // Looking at a potion for a screenshot must not make its fact look slow or helped: brew it without help.
        }
        const result = await brewOne(page);
        check(result.kind === 'brewed' && result.want.solved.test(result.shown), `${tag}: "${sum}" brews, and the card shows the finished sum`, `${result.kind}: ${result.shown}`);
        if (kindOf === 'bridge') {
          const first = 10 - a;
          check(result.shown === `${a} + ${b} = ${a} + ${first} + ${b - first} = ${a + b}`, `${tag}: the card shows how ${a} + ${b} goes through 10`, result.shown);
        }
        if (kindOf === 'near') {
          const small = Math.min(a, b);
          check(result.shown === `${a} + ${b} = ${small} + ${small} + 1 = ${a + b}`, `${tag}: the card shows ${a} + ${b} as a double and 1 more`, result.shown);
        }
        if (turn === 8) {
          await sleep(size === SIZES[0] ? 1100 : 300);
          check(await resultCardFits(page), `${tag}: the ${name} result card fits on screen`);
          await shot(page, `24-drill-${drill}-result-${size.name}`);
        }
        stars += 2;
        brewed += 1;
        await tapNext(page);
      }
      const core = drill === 'make10' ? 'pair' : 'double';
      check(kinds.slice(0, 6).every((k) => k === core) && kinds.slice(6).every((k) => k !== core), `${tag}: ${name} asks six core facts first, then two that build on them`, kinds.join());
      check(new Set(sums).size === 8, `${tag}: no ${name} potion comes twice in a round`, sums.join(' | '));
      await page.waitForSelector('#screen-done:not([hidden])');
      await sleep(600);
      check(await donePanelFits(page), `${tag}: the round-complete card fits after ${name}`);
      check(!(await isShowing(page, '#speedy-offer')) && !(await isShowing(page, '#done-best')), `${tag}: no speedy brew is offered after a first ${name} round`);
      check((await page.locator('#done-summary').innerText()).includes('8 potions and earned 16 stars'), `${tag}: the ${name} round earns stars like any other`);
      let facts = (await readFacts(page)).facts;
      check(sums.every((sum) => {
        const key = sum.replace(/ /g, '').replace('=?', '');
        return facts[key] && facts[key].box === 1 && facts[key].pace === 'quick' && facts[key].times.length === 1;
      }), `${tag}: every ${name} answer is in the fact memory, timed and quick`, Object.keys(facts).join());

      // ---- Play again stays in the same drill, and its six core facts include the ones not asked yet
      await tap(page, '#btn-again');
      await page.waitForSelector('#screen-brew:not([hidden])');
      const again = [];
      for (let turn = 1; turn <= (drill === 'make10' ? 6 : 1); turn++) {
        const seen = await readBrew(page);
        again.push(seen.equation.join(' '));
        check(seen.topic === drill, `${tag}: Play again starts another ${name} round`, seen.topic);
        if (turn < 6) {
          await brewOne(page);
          await tapNext(page);
          stars += 2;
          brewed += 1;
        }
      }
      if (drill === 'make10') {
        const fresh = again.filter((sum) => !sums.includes(sum));
        check(fresh.length === 3 && again.every((sum) => sum.endsWith('? = 10')), `${tag}: the next ${name} round asks the three pairs that were not asked yet`, again.join(' | '));
      }
      await tap(page, '#btn-brew-quit');
      await page.waitForSelector('#screen-home:not([hidden])');
      await tap(page, '#btn-potions');
      await page.waitForSelector('#screen-potions:not([hidden])');
      const sub = await page.locator(`#btn-drill-${drill} .menu-sub`).innerText();
      check(sub === 'Warming up…', `${tag}: the ${name} card says the drill has been started (nothing is quick yet)`, sub);
      await tap(page, '#screen-potions [data-go="home"]');
      await page.waitForSelector('#screen-home:not([hidden])');
      facts = (await readFacts(page)).facts;
      check(Object.values(facts).every((f) => f.box <= 2 && !f.miss), `${tag}: nothing is quick after one or two answers`);
    }

    // ---- stars are the shared ones, and the save has its old shape
    const saved = await readSaved(page);
    check(saved.stars === stars && saved.math.brewed === brewed, `${tag}: drill potions earn the shared stars`, `${saved.stars} stars (wanted ${stars}), ${saved.math.brewed} potions (wanted ${brewed})`);
    check(JSON.stringify(Object.keys(saved)) === JSON.stringify(MAIN_SAVE_KEYS) && JSON.stringify(Object.keys(saved.math)) === '["level","topics","brewed"]',
      `${tag}: the game save keeps its old shape`, `${Object.keys(saved).join()} / ${Object.keys(saved.math).join()}`);
    check((await page.locator('#screen-home [data-stars]').innerText()).trim() === String(stars), `${tag}: home shows the stars`);
    check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
    await context.close();
  }
}

// ---------------------------------------------------------------- math scenario: the optional speedy brew

const openGrownUps = async (page, browserName) => {
  await hold(page, browserName, '#btn-parent', 2300);
  await page.waitForSelector('#screen-parent:not([hidden])', { timeout: 3000 });
};

async function speedyBrews(browser, browserName, baseUrl) {
  const tag = 'speedy brew';
  // Eight of the nine make-10 pairs are quick already. The ninth is one quick answer away.
  const pairs = Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`${n}+?=10`, savedFact(3)]));
  pairs['1+?=10'] = savedFact(2, { due: true, seen: 2, right: 2, times: [3000, 3000] });
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], {
    reducedMotion: 'reduce', clock: true, saved: { stars: 5 }, savedFacts: { facts: pairs, speed: {} },
  });
  const speedyOf = async () => (await readFacts(page)).speed.make10;
  const starsShown = async (screen) => (await page.locator(`${screen} [data-stars]`).innerText()).trim();

  // ---- not offered yet: one fact is not quick
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-potions:not([hidden])');
  await checkMenu(page, `${tag}, before it is earned`);
  check((await page.locator('#btn-drill-make10 .menu-sub').innerText()) === '8 of 9 quick', `${tag}: the Make 10 card says 8 of 9 facts are quick`);
  check(!(await isShowing(page, '#btn-speedy-make10')), `${tag}: it is not offered while one fact is not quick yet`);

  // ---- the drill round that makes the last fact quick
  await tap(page, '#btn-drill-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  const sums = [];
  for (let turn = 1; turn <= 8; turn++) {
    const result = await brewOne(page);
    sums.push(result.seen.equation.join(' '));
    check(result.kind === 'brewed', `${tag}: drill turn ${turn} brews`, result.kind);
    await tapNext(page);
  }
  check(sums.slice(0, 4).every((sum) => sum.endsWith('? = 10')) && sums.slice(4).every((sum) => sum.endsWith('= ?')),
    `${tag}: with the pairs nearly all quick, the drill gives half its round to bridging through 10`, sums.join(' | '));
  check(sums.includes('1 + ? = 10'), `${tag}: the one pair that still needs practice is asked`, sums.join(' | '));
  await page.waitForSelector('#screen-done:not([hidden])');
  await sleep(400);
  check(await isShowing(page, '#speedy-offer'), `${tag}: once every pair is quick, a speedy brew is offered after the round`);
  const offer = await page.locator('#speedy-offer-text').innerText();
  check(/New!/.test(offer) && /speedy brew/i.test(offer) && /just for fun/i.test(offer) && /No rush/i.test(offer), `${tag}: the offer is gentle and says it is just for fun`, offer);
  const offerButtons = await page.evaluate(() => ['#btn-offer-go', '#btn-offer-skip', '#btn-again', '#btn-done-home'].map((sel) => {
    const box = document.querySelector(sel).getBoundingClientRect();
    return box.height >= 60 && box.width >= 60 && box.top >= 0 && box.bottom <= window.innerHeight;
  }));
  check(offerButtons.every(Boolean), `${tag}: "Try it", "Not now", "Play again" and "Home" are all big and on screen`, offerButtons.join());
  check(await donePanelFits(page), `${tag}: the round-complete card still fits with the offer`);
  check((await speedyOf()).unlocked === true && (await speedyOf()).plays === 0, `${tag}: earning it is remembered`, JSON.stringify(await speedyOf()));
  await shot(page, '26-speedy-offer-portrait');

  // ---- it can always be skipped
  await tap(page, '#btn-offer-skip');
  check(!(await isShowing(page, '#speedy-offer')) && await isShowing(page, '#btn-again') && await isShowing(page, '#btn-done-home'),
    `${tag}: "Not now" puts the offer away and leaves the other buttons`);
  check((await readSaved(page)).stars === 21, `${tag}: skipping costs nothing`, String((await readSaved(page)).stars));
  await tap(page, '#btn-done-home');
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-potions:not([hidden])');
  await sleep(300);
  const cards = await checkMenu(page, `${tag}, once it is earned`, ['make10']);
  check(/Speedy brew/.test(cards[2].text) && /Just for fun!/.test(cards[2].text), `${tag}: the menu now has a speedy brew under Make 10`, cards[2].text);
  check((await page.locator('#btn-drill-make10 .menu-sub').innerText()) === 'All quick! ⭐', `${tag}: the Make 10 card says all its facts are quick`);
  await shot(page, '26-speedy-menu-portrait');

  // ---- the speedy brew: no countdown, no result cards, nothing to lose
  let spokenBefore = (await spokenList(page)).length;
  await tap(page, '#btn-speedy-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  let help = await readHelp(page);
  check(help.mode === 'speedy' && help.buttons.length === 0 && !help.open, `${tag}: there are no Dots or Hint buttons in a speedy brew`, `${help.mode} ${help.buttons.join()}`);
  check(/No rush/.test(help.note) && /just for fun/.test(help.note), `${tag}: a kind note says there is no rush`, help.note);
  let spoken = (await spokenList(page)).slice(spokenBefore);
  check(spoken.length === 1 && /Speedy brew/.test(spoken[0].text) && /No rush/.test(spoken[0].text), `${tag}: the round is greeted, and the potions are not read out one by one`, spoken.map((s) => s.text).join(' | '));
  const clockFree = await page.evaluate(() => {
    const screen = document.querySelector('#screen-brew');
    const ticking = [...screen.querySelectorAll('progress, meter, [class*="timer"], [class*="countdown"], [class*="clock"], [class*="time"]')].filter((node) => node.offsetParent !== null);
    return { ticking: ticking.length, text: screen.innerText.replace(/\s+/g, ' ') };
  });
  check(clockFree.ticking === 0 && !/\d\s*(s|sec|seconds?)\b|\d:\d\d|hurry|quick!|faster/i.test(clockFree.text), `${tag}: there is no timer or countdown on screen`, clockFree.text);
  check((await page.locator('#brew-icon').innerText()).includes('⚡') && (await page.locator('#brew-progress .rp-star').count()) === 8, `${tag}: it is 8 potions long`);
  await checkPlayLayout(page, tag, '#screen-brew', BREW_ROWS);
  await checkBrewPicture(page, tag);
  await shot(page, '26-speedy-round-portrait');

  // The first potion is missed on purpose: a kind word, and on it goes.
  const first = await speedyOne(page, 1, { miss: true });
  const right = first.seen.equation.map((part) => (part === '?' ? first.want.digits : part)).join(' ');
  check(!first.result, `${tag}: a wrong answer shows no result card`);
  check(first.help.note === `Almost! ${right}`, `${tag}: a wrong answer gets a kind word and the finished sum`, first.help.note);
  check(!/[✗✘❌]|wrong|bad|fail|oops/i.test(first.help.note), `${tag}: the kind word never shames`, first.help.note);
  check((await starsShown('#screen-brew')) === '21', `${tag}: a wrong answer takes no stars away`, await starsShown('#screen-brew'));
  check((await page.locator('#brew-progress .rp-star.is-tried').count()) === 1 && (await page.locator('#brew-progress .rp-star.is-done').count()) === 0,
    `${tag}: its star is filled in softly, not in gold`);
  spoken = await spokenList(page);
  check(new RegExp(`${first.want.digits}`).test(spoken[spoken.length - 1].text) && !/fizzle|oops/i.test(spoken[spoken.length - 1].text), `${tag}: the right answer is said kindly`, spoken[spoken.length - 1].text);
  const asked = [first.seen.equation.join(' ')];
  for (let turn = 2; turn <= 8; turn++) {
    help = await readHelp(page);
    check(/No rush/.test(help.note), `${tag}: turn ${turn} starts with the kind note again`, help.note);
    const one = await speedyOne(page, turn);
    asked.push(one.seen.equation.join(' '));
    check(!one.result, `${tag}: turn ${turn} moves on without a result card`);
  }
  await page.waitForSelector('#screen-done:not([hidden])');
  check(new Set(asked).size === 8, `${tag}: the missed potion does not have to be done again`, asked.join(' | '));
  check(asked.every((sum) => sum.endsWith('? = 10')), `${tag}: it only asks facts that are quick already`, asked.join(' | '));
  await sleep(400);
  const done = async () => ({
    title: await page.locator('#done-title').innerText(),
    summary: await page.locator('#done-summary').innerText(),
    best: await page.locator('#done-best').innerText(),
    stars: await page.locator('#done-words .done-word-stars').allInnerTexts(),
  });
  let end = await done();
  check(end.title === 'Speedy brew done!' && /^You brewed 7 of 8 speedy potions in \d+ seconds?, and earned 3 stars!$/.test(end.summary), `${tag}: the end says how many potions and how long`, `${end.title} ${end.summary}`);
  check(end.best === '🏆 That is your first record!', `${tag}: the first run is celebrated as a record`, end.best);
  check(end.stars.filter((text) => text === '⭐').length === 7 && end.stars.length === 8, `${tag}: the list shows which potions were brewed`, end.stars.join('|'));
  check((await readSaved(page)).stars === 24, `${tag}: joining in earns 3 stars, also with a potion missed`, String((await readSaved(page)).stars));
  let speedy = await speedyOf();
  check(speedy.plays === 1 && speedy.best.right === 7 && speedy.best.total === 8 && speedy.best.ms > 0, `${tag}: the run is saved as the personal best`, JSON.stringify(speedy));
  check(!(await isShowing(page, '#speedy-offer')) && await donePanelFits(page), `${tag}: the end card fits, with no second offer on it`);
  await shot(page, '26-speedy-done-portrait');
  const missedKey = first.seen.equation.join('').replace(/ /g, '');
  check((await readFacts(page)).facts[missedKey].miss === true, `${tag}: the missed fact goes back into practice`, missedKey);

  // ---- a second run with every potion right: a new personal best
  await tap(page, '#btn-again');
  await page.waitForSelector('#screen-brew:not([hidden])');
  check((await readHelp(page)).mode === 'speedy', `${tag}: Play again starts another speedy brew`);
  for (let turn = 1; turn <= 8; turn++) await speedyOne(page, turn);
  await page.waitForSelector('#screen-done:not([hidden])');
  end = await done();
  check(/^You brewed 8 of 8 speedy potions/.test(end.summary) && end.best === '🏆 New personal best!', `${tag}: beating the record is celebrated`, `${end.summary} ${end.best}`);
  spoken = await spokenList(page);
  check(/New personal best/.test(spoken[spoken.length - 1].text), `${tag}: the personal best is cheered out loud`, spoken[spoken.length - 1].text);
  speedy = await speedyOf();
  const bestMs = speedy.best.ms;
  check(speedy.plays === 2 && speedy.best.right === 8, `${tag}: the new best is saved`, JSON.stringify(speedy));

  // ---- a slower run: still stars, still kind, and the best stays
  await tap(page, '#btn-again');
  await page.waitForSelector('#screen-brew:not([hidden])');
  for (let turn = 1; turn <= 8; turn++) await speedyOne(page, turn, { think: 4000 });
  await page.waitForSelector('#screen-done:not([hidden])');
  end = await done();
  const took = Number(/in (\d+) seconds/.exec(end.summary)[1]);
  check(took >= 32, `${tag}: the time is the thinking time added up`, end.summary);
  check(/^Your best is 8 of 8 in \d+ seconds?\. Maybe next time!$/.test(end.best), `${tag}: a slower run is told the best, kindly`, end.best);
  speedy = await speedyOf();
  check(speedy.plays === 3 && speedy.best.ms === bestMs && (await readSaved(page)).stars === 30, `${tag}: a slower run keeps the best and still earns its 3 stars`, `${JSON.stringify(speedy)}, ${(await readSaved(page)).stars} stars`);

  // ---- leaving in the middle costs nothing
  await tap(page, '#btn-again');
  await page.waitForSelector('#screen-brew:not([hidden])');
  await speedyOne(page, 1);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await speedyOf()).plays === 3 && (await readSaved(page)).stars === 30 && (await starsShown('#screen-home')) === '30', `${tag}: leaving in the middle changes neither stars nor record`);
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-potions:not([hidden])');
  const bestLine = await page.locator('#btn-speedy-make10 .menu-sub').innerText();
  check(/^Best: 8 of 8 in \d+ seconds?$/.test(bestLine), `${tag}: the menu shows the personal best`, bestLine);
  check((await readFacts(page)).facts[missedKey].miss === true && await isShowing(page, '#btn-speedy-make10'), `${tag}: a missed fact never takes the speedy brew away again`);
  check(!(await isShowing(page, '#btn-speedy-doubles')), `${tag}: Doubles has no speedy brew until its own facts are quick`);
  await tap(page, '#screen-potions [data-go="home"]');
  await openGrownUps(page, browserName);
  const line = await page.locator('#facts-speedy').innerText();
  check(/Make 10: speedy brew best 8 of 8 in \d+ seconds?/.test(line) && /Doubles: 0 of 10 facts quick/.test(line), `${tag}: the grown-ups see the best and how far Doubles is`, line);
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- the fullest menu (both speedy brews) on every tight screen, and the offer on the two smallest
  const both = { make10: { unlocked: true, plays: 4, best: { right: 8, total: 8, ms: 123400 } }, doubles: { unlocked: true, plays: 0, best: null } };
  for (const size of TIGHT_SIZES) {
    const small = await openPage(browser, baseUrl, size, { reducedMotion: 'reduce', saved: { stars: 5 }, savedFacts: { facts: pairs, speed: both } });
    await tap(small.page, '#btn-potions');
    await small.page.waitForSelector('#screen-potions:not([hidden])');
    await sleep(200);
    await checkMenu(small.page, `${tag} menu, ${size.name}`, DRILLS);
    await shot(small.page, `26-speedy-menu-${size.name}`);
    if (size.name.startsWith('small')) {
      await tap(small.page, '#btn-drill-make10');
      await small.page.waitForSelector('#screen-brew:not([hidden])');
      for (let turn = 1; turn <= 8; turn++) {
        await brewOne(small.page);
        await tapNext(small.page);
      }
      await small.page.waitForSelector('#screen-done:not([hidden])');
      await sleep(300);
      check(await isShowing(small.page, '#speedy-offer') && await donePanelFits(small.page), `${tag} offer, ${size.name}: the offer fits on the round-complete card, with Play again in reach`);
      const reach = await small.page.evaluate(() => ['#btn-offer-go', '#btn-offer-skip'].every((sel) => {
        const box = document.querySelector(sel).getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight && box.height >= 60;
      }));
      check(reach, `${tag} offer, ${size.name}: "Try it" and "Not now" are in reach without scrolling`);
      await shot(small.page, `26-speedy-offer-${size.name}`);
    }
    check(small.problems.length === 0, `${tag}, ${size.name}: no errors in the browser console`, small.problems.slice(0, 3).join(' | '));
    await small.context.close();
  }
}

// ---------------------------------------------------------------- math scenario: slow facts for the grown-ups

async function factsForGrownUps(browser, browserName, baseUrl) {
  let tag = 'slow facts';
  const words = ['because', 'friend', 'people'];
  const onlyAdd = Object.fromEntries(ALL_TOPICS.map((id) => [id, id === 'add']));
  const saved = {
    words, custom: true, roundSize: 3, progress: { because: { step: 3, mastered: 1, best: 3, last: 1 } },
    math: { level: 'easy', topics: onlyAdd, brewed: 4 }, stars: 30, robe: 'bubblegum', familiar: 'owl', chimes: true,
  };
  const savedFacts = {
    facts: {
      '8+5': savedFact(0, { due: true, miss: true, seen: 3, right: 1, times: [7000] }),
      '6+?=10': savedFact(1, { due: true, pace: 'helped', seen: 2, right: 2, times: [] }),
      '7+6': savedFact(2, { due: true, pace: 'slow', seen: 4, right: 4, times: [3000, 9400] }),
      '9+9': savedFact(4, { seen: 6, right: 6 }),
      '5+5': savedFact(3),
    },
    speed: { doubles: { unlocked: true, plays: 2, best: { right: 8, total: 8, ms: 31400 } } },
  };
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { reducedMotion: 'reduce', clock: true, saved, savedFacts });
  const readPanel = () => page.evaluate(() => ({
    summary: document.querySelector('#facts-summary').textContent,
    rows: [...document.querySelectorAll('#slow-facts .fact-row')].map((row) => `${row.querySelector('.fact-name').textContent} — ${row.querySelector('.fact-note').textContent}`),
    why: [...document.querySelectorAll('#slow-facts .fact-row')].map((row) => `${row.dataset.fact}:${row.dataset.why}`).join(),
    note: document.querySelector('#slow-facts-note').textContent,
    speedy: document.querySelector('#facts-speedy').textContent,
    message: document.querySelector('#facts-message').textContent,
    reset: document.querySelector('#btn-reset-facts').textContent,
    fine: document.querySelector('#btn-reset-facts').closest('.panel').innerText.replace(/\s+/g, ' '),
  }));
  const showPanel = () => page.locator('#slow-facts').evaluate((node) => node.closest('.panel').scrollIntoView({ block: 'center' }));
  const goHome = async () => {
    await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
    await page.waitForSelector('#screen-home:not([hidden])');
  };

  // ---- the list as saved on another day
  await openGrownUps(page, browserName);
  let panel = await readPanel();
  check(panel.summary === '5 facts practiced · 2 quick · 3 slow or missed.', `${tag}: the grown-up sees how many facts are practiced, quick and slow`, panel.summary);
  check(panel.why === '8+5:missed,6+?=10:helped,7+6:slow', `${tag}: missed facts are listed first, then helped, then slow; quick ones are not listed`, panel.why);
  check(panel.rows[0] === '8 + 5 — missed last time · right 1 of 3', `${tag}: a missed fact says so, with how often it was right`, panel.rows[0]);
  check(panel.rows[1] === '6 + ? = 10 — needed the dots or the hint · right 2 of 2', `${tag}: a make-10 pair is written as a sum with a gap`, panel.rows[1]);
  check(panel.rows[2] === '7 + 6 — took 9 seconds · right 4 of 4', `${tag}: a slow fact shows the time it took`, panel.rows[2]);
  check(/come back more often/.test(panel.note), `${tag}: the grown-up is told that these come back more often`, panel.note);
  check(/Make 10: 0 of 9 facts quick/.test(panel.speedy) && /Doubles: speedy brew best 8 of 8 in 31 seconds/.test(panel.speedy), `${tag}: the speedy brews are summed up`, panel.speedy);
  check(/6 seconds/.test(panel.fine) && /skipped/.test(panel.fine) && panel.reset === 'Reset math facts', `${tag}: the panel explains "quick" and has a reset button`, panel.reset);
  await showPanel();
  const tidy = await page.evaluate(() => {
    const body = document.querySelector('.parent-body').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#slow-facts .fact-row, #btn-reset-facts')].map((node) => node.getBoundingClientRect());
    const btn = document.querySelector('#btn-reset-facts').getBoundingClientRect();
    return boxes.every((b) => b.left >= body.left && b.right <= body.right && b.width > 100) && btn.height >= 60 && document.documentElement.scrollWidth <= window.innerWidth + 1;
  });
  check(tidy, `${tag}: the list and its reset button fit in the grown-ups' corner`);
  await sleep(300);
  await shot(page, '25-grownups-math-facts-portrait');
  await goHome();

  // ---- playing changes the list: helped, quick again, and a new slow one
  await useRound(page, [['add', 8, 5], ['add', 7, 6], ['add', 4, 9], ['add', 2, 2]]);
  await startPotions(page);
  check((await readHelp(page)).view === 'dots', `${tag}: the fact missed on another day opens with its dots`);
  await brewOne(page);                 // 8 + 5: right, with the dots showing
  await tapNext(page);
  await brewOne(page);                 // 7 + 6: right and quick
  await tapNext(page);
  await sleep(60);                     // (the voice is done reading: the stopwatch leaves that time out)
  await page.evaluate(() => window.__wait(9200));
  await brewOne(page);                 // 4 + 9: right, but after nine seconds
  await tapNext(page);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  await openGrownUps(page, browserName);
  panel = await readPanel();
  check(panel.why === '6+?=10:helped,8+5:helped,4+9:slow' || panel.why === '8+5:helped,6+?=10:helped,4+9:slow', `${tag}: after playing, the list shows what is slow now`, panel.why);
  check(panel.rows.includes('8 + 5 — needed the dots or the hint · right 2 of 4'), `${tag}: a fact answered with the dots still counts as needing help`, panel.rows.join(' | '));
  check(panel.rows.some((row) => /^4 \+ 9 — took (9|10) seconds · right 1 of 1$/.test(row)), `${tag}: an answer that took nine seconds is listed as slow`, panel.rows.join(' | '));
  check(!panel.why.includes('7+6'), `${tag}: a slow fact that is answered quickly leaves the list`);
  check(panel.summary === '6 facts practiced · 3 quick · 3 slow or missed.', `${tag}: the summary follows`, panel.summary);

  // ---- reset math facts: two taps, and only the facts go
  const before = await readSaved(page);
  await showPanel();
  await tap(page, '#btn-reset-facts');
  panel = await readPanel();
  check(/Tap again/.test(panel.reset) && Object.keys((await readFacts(page)).facts).length === 6, `${tag}: one tap on reset only asks to tap again`, panel.reset);
  await tap(page, '#btn-reset-facts');
  panel = await readPanel();
  let facts = await readFacts(page);
  check(JSON.stringify(facts) === '{"facts":{},"speed":{}}', `${tag}: the second tap empties the fact memory and the speedy bests`, JSON.stringify(facts));
  check(/No facts practiced yet/.test(panel.summary) && panel.rows.length === 0 && panel.reset === 'Reset math facts', `${tag}: the list is empty after the reset`, panel.summary);
  check(/reset/i.test(panel.message) && /Stars and words are untouched/.test(panel.message), `${tag}: the grown-up is told what was reset`, panel.message);
  check(JSON.stringify(await readSaved(page)) === JSON.stringify(before), `${tag}: resetting the facts leaves words, stars and settings exactly as they were`);
  check(before.stars === 36 && JSON.stringify(before.words) === JSON.stringify(words) && before.progress.because.mastered === 1, `${tag}: the saved words and stars are all still there`, JSON.stringify(before.words));
  await goHome();
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-potions:not([hidden])');
  check(!(await isShowing(page, '#btn-speedy-doubles')) && (await page.locator('#btn-drill-doubles .menu-sub').innerText()) === '6 + 6, then 6 + 7', `${tag}: after the reset the drills are new again`);

  // ---- "Reset stars & progress" clears the facts too, and keeps the word list
  await tap(page, '#btn-drill-doubles');
  await page.waitForSelector('#screen-brew:not([hidden])');
  await brewOne(page);
  await tapNext(page);
  await tap(page, '#btn-brew-quit');
  check(Object.keys((await readFacts(page)).facts).length === 1, `${tag}: a new answer starts the fact memory again`);
  await openGrownUps(page, browserName);
  await page.locator('#btn-reset').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-reset');
  await tap(page, '#btn-reset');
  facts = await readFacts(page);
  const after = await readSaved(page);
  check(JSON.stringify(facts) === '{"facts":{},"speed":{}}' && after.stars === 0, `${tag}: "Reset stars & progress" clears the math facts as well`, JSON.stringify(facts));
  check(JSON.stringify(after.words) === JSON.stringify(words) && after.custom === true && after.math.level === 'easy' && after.roundSize === 3, `${tag}: ... and keeps the word list and the settings`, JSON.stringify(after.words));
  check(/math facts/i.test(await page.locator('#btn-reset').evaluate((node) => node.closest('.panel').innerText)), `${tag}: the reset panel says that the math facts go too`);
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- a damaged fact memory never breaks the game
  tag = 'damaged fact memory';
  const damaged = ['{"facts":{"8+5":{"seen":3,"box"', '"just a string"', '[1,2,3]',
    '{"facts":{"8+5":"slow","__proto__":{"seen":1},"constructor":{"seen":2,"box":3}},"speed":7}'];
  for (const text of damaged) {
    const odd = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', savedFacts: text, saved: { words, custom: true, stars: 9 } });
    await openGrownUps(odd.page, browserName);
    check(/No facts practiced yet/.test(await odd.page.locator('#facts-summary').innerText()), `${tag}: it is read as "no facts yet" (${text.slice(0, 18)}…)`);
    check(JSON.stringify((await readSaved(odd.page))?.words ?? words) === JSON.stringify(words) && (await odd.page.locator('#word-input').inputValue()) === words.join('\n'), `${tag}: the saved words are still there`);
    await tap(odd.page, '#screen-parent .parent-buttons-end [data-go="home"]');
    await startPotions(odd.page, '#btn-drill-make10');
    check((await brewOne(odd.page)).kind === 'brewed', `${tag}: a drill potion still brews`);
    const mended = await readFacts(odd.page);
    check(mended && Object.keys(mended.facts).length === 1 && Object.values(mended.facts)[0].seen === 1, `${tag}: the next answer writes a good fact memory`, JSON.stringify(mended));
    check((await readSaved(odd.page)).stars === 11 && JSON.stringify((await readSaved(odd.page)).words) === JSON.stringify(words), `${tag}: stars and words are saved as always`);
    check(odd.problems.length === 0, `${tag}: no errors in the browser console`, odd.problems.slice(0, 3).join(' | '));
    await odd.context.close();
  }

  // ---- a device that cannot save: the drills work for this visit
  tag = 'math facts without storage';
  for (const storage of ['full', 'blocked']) {
    const dry = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', storage });
    await startPotions(dry.page, '#btn-drill-doubles');
    await tap(dry.page, '#btn-dots');
    check((await readHelp(dry.page)).view === 'dots', `${tag} (${storage}): the dots still open`);
    check((await brewOne(dry.page)).kind === 'brewed', `${tag} (${storage}): a drill potion still brews`);
    await tapNext(dry.page);
    await tap(dry.page, '#btn-brew-quit');
    await openGrownUps(dry.page, browserName);
    check(await isShowing(dry.page, '#save-note'), `${tag} (${storage}): the grown-ups' corner says that saving is not working`);
    const dryPanel = await dry.page.locator('#slow-facts').evaluate((node) => node.closest('.panel').innerText.replace(/\s+/g, ' '));
    check(/1 fact practiced/.test(dryPanel) && /needed the dots or the hint/.test(dryPanel), `${tag} (${storage}): the fact is remembered for this visit`, dryPanel.slice(0, 120));
    await dry.page.locator('#btn-reset-facts').evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await tap(dry.page, '#btn-reset-facts');
    await tap(dry.page, '#btn-reset-facts');
    check(/this visit only/.test(await dry.page.locator('#facts-message').innerText()), `${tag} (${storage}): a reset does not claim to be saved`, await dry.page.locator('#facts-message').innerText());
    check(dry.problems.length === 0, `${tag} (${storage}): no errors in the browser console`, dry.problems.slice(0, 3).join(' | '));
    await dry.context.close();
  }
}

// ---------------------------------------------------------------- math scenario: a save from before the update

// Exactly what the game wrote before the math update: one key, these fields, in
// this order. Nothing in it may be lost, renamed or reshaped.
const OLD_SAVE = '{"words":["because","friend","people","don\'t"],"custom":true,"roundSize":3,' +
  '"progress":{"because":{"step":3,"mastered":1,"best":3,"last":1760000000000},"friend":{"step":2,"mastered":0,"best":0,"last":0}},' +
  '"math":{"level":"easy","topics":{"add":false,"sub":true,"place":false,"skip":false,"story":false,"time":false,"coins":false},"brewed":5},' +
  '"stars":12,"robe":"bubblegum","familiar":"owl","chimes":false}';

async function oldSaveSurvives(browser, browserName, baseUrl) {
  const tag = 'save from before the math update';
  const old = JSON.parse(OLD_SAVE);
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', saved: OLD_SAVE });
  const raw = (key) => page.evaluate((key) => window.localStorage.getItem(key), key);
  const keysInStorage = () => page.evaluate(() => Object.keys(window.localStorage).sort().join());

  // ---- opening the game changes nothing
  check((await raw(STORE_KEY)) === OLD_SAVE && (await raw(FACTS_KEY)) === null, `${tag}: opening the game rewrites nothing and adds no key`, await keysInStorage());
  check((await page.locator('#screen-home [data-stars]').innerText()).trim() === '12', `${tag}: the stars are there`);
  check(/1 of 4 words mastered/.test(await page.locator('#btn-spells').innerText()) && /5 potions brewed/.test(await page.locator('#btn-potions').innerText()),
    `${tag}: the home screen shows the saved words and potions`, await page.locator('#btn-spells').innerText());
  check((await page.locator('#screen-home [data-familiar]').innerText()).includes('🦉'), `${tag}: the chosen familiar is there`);
  await tap(page, '#btn-book');
  await page.waitForSelector('#screen-book:not([hidden])');
  const book = await page.locator('.book-word').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.word}:${node.querySelector('.book-note').textContent}`));
  check(book.join() === "because:✨ Mastered,friend:Step 2 of 4,people:Step 1 of 4,don't:Step 1 of 4", `${tag}: the spellbook shows every saved word at its saved step`, book.join());
  await tap(page, '#screen-book [data-go="home"]');

  // ---- spelling still works, with the saved words
  await tap(page, '#btn-spells');
  await page.waitForSelector('#screen-play:not([hidden])');
  check((await page.locator('#round-progress .rp-star').count()) === 3, `${tag}: a spelling round has 3 spells, as saved`);
  let turn = await readTurn(page, old.words);
  check(turn.word === 'friend' && turn.step === 2, `${tag}: the first spell is "friend" at its saved step 2`, `${turn.word} at step ${turn.step}`);
  await tapLetters(page, planTaps(turn, false));
  check((await castAndSeeResult(page)) === 'success', `${tag}: the spell can be cast`);
  await tapNext(page);
  turn = await readTurn(page, old.words);
  check(old.words.includes(turn.word) && turn.word !== 'friend', `${tag}: the next spell is another saved word`, String(turn.word));
  await tap(page, '#btn-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await raw(FACTS_KEY)) === null, `${tag}: spelling never touches the fact memory`);

  // ---- the new math screens: a drill, the dots, the hint, and the saved settings in a mixed round
  await startPotions(page, '#btn-drill-make10');
  await tap(page, '#btn-dots');
  await tap(page, '#btn-hint');
  check((await readHelp(page)).view === 'hint', `${tag}: the hint opens in a drill`);
  check((await brewOne(page)).kind === 'brewed', `${tag}: a Make 10 potion brews`);
  await tapNext(page);
  check((await brewOne(page)).kind === 'brewed', `${tag}: a second Make 10 potion brews`);
  await tapNext(page);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  await startPotions(page);
  const mixed = await brewOne(page);
  check(mixed.seen.topic === 'sub' && mixed.want.numbers.every((n) => n <= 20) && mixed.kind === 'brewed', `${tag}: mixed potions still follow the saved level and topics`, mixed.seen.equation.join(' '));
  await tapNext(page);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');

  // ---- the grown-ups' corner shows the words, and a facts reset leaves them alone
  await openGrownUps(page, browserName);
  check((await page.locator('#word-input').inputValue()) === old.words.join('\n'), `${tag}: the word box shows the saved words`);
  check((await page.locator('#parent-preview .chip').allInnerTexts()).join() === old.words.join(), `${tag}: so does the list under it`);
  check((await page.locator('#math-level .seg-btn[aria-pressed="true"]').getAttribute('data-level')) === 'easy' &&
    (await page.locator('#math-topics .toggle[aria-pressed="true"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.topic).join())) === 'sub',
    `${tag}: the math level and topics are as saved`);
  check(/2 facts practiced/.test(await page.locator('#facts-summary').innerText()), `${tag}: the two drill answers are in the fact list`, await page.locator('#facts-summary').innerText());
  await page.locator('#btn-reset-facts').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-reset-facts');
  await tap(page, '#btn-reset-facts');
  let now = await readSaved(page);
  check(JSON.stringify(Object.keys(now).filter((k) => k !== 'week' && k !== 'weekOnly')) === JSON.stringify(Object.keys(old)) && JSON.stringify(Object.keys(now.math)) === JSON.stringify(Object.keys(old.math)),
    `${tag}: the save has the same fields as before, in the same order`, Object.keys(now).join());
  check(JSON.stringify(now.words) === JSON.stringify(old.words) && now.custom === true && now.roundSize === 3, `${tag}: the word list is untouched`, JSON.stringify(now.words));
  check(JSON.stringify(now.progress.because) === JSON.stringify(old.progress.because) && now.progress.friend.step === 3 && now.progress.friend.mastered === 0,
    `${tag}: spelling progress is untouched, apart from the spell just cast`, JSON.stringify(now.progress));
  check(JSON.stringify(now.math.topics) === JSON.stringify(old.math.topics) && now.math.level === 'easy' && now.math.brewed === 8, `${tag}: math settings are untouched and the potions are counted`, JSON.stringify(now.math));
  check(now.stars === 18 && now.robe === 'bubblegum' && now.familiar === 'owl' && now.chimes === false, `${tag}: stars went up by what was earned; robe, familiar and chimes are as saved`, `${now.stars} ${now.robe} ${now.familiar} ${now.chimes}`);
  check((await keysInStorage()) === [FACTS_KEY, STORE_KEY].sort().join(), `${tag}: the fact memory is the only new key`, await keysInStorage());

  // ---- a grown-up can still save words, and everything survives a reload
  await page.locator('.parent-body').evaluate((node) => { node.scrollTop = 0; });
  await page.locator('#word-input').fill("because\nfriend\npeople\ndon't\nmagic");
  await tap(page, '#btn-save-words');
  check(/Saved 5 words/.test(await page.locator('#parent-message').innerText()), `${tag}: a new word can be added to the list`, await page.locator('#parent-message').innerText());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  now = await readSaved(page);
  check(now.words.join() === "because,friend,people,don't,magic" && now.stars === 18 && now.progress.because.mastered === 1 && now.robe === 'bubblegum',
    `${tag}: words, stars, progress and robe survive a reload`, JSON.stringify(now.words));
  check(/1 of 5 words mastered/.test(await page.locator('#btn-spells').innerText()), `${tag}: the home screen shows the new list`);
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ================================================================ the math review (mathup/REVIEW-MATH.md)
// One scenario for each finding of the independent review of the math update.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SPEEDY_EARNED = { make10: { unlocked: true, plays: 0, best: null } };

// The nine make-10 pairs for a seeded fact memory: the `quick` ones are quick, the rest as `other(n)` says.
const seededPairs = (quick, other) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`${n}+?=10`, quick.includes(n) ? savedFact(3) : other(n)]));

// Puts a fact memory into localStorage and opens the game again, like coming back to it later.
async function reopenWith(page, facts) {
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, JSON.stringify(value)), [FACTS_KEY, facts]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
}

const leaveGrownUps = async (page) => {
  await tap(page, '#screen-parent .parent-buttons-end [data-go="home"]');
  await page.waitForSelector('#screen-home:not([hidden])');
};

// ---------------------------------------------------------------- math fix 1: two saves, each watched on its own

async function partlyFailedSave(browser, browserName, baseUrl) {
  const words = ['because', 'friend'];
  const refuse = (page, key) => page.evaluate((key) => { window.__storageFull = key; }, key);
  const saveWords = async (page, text) => {
    await page.locator('.parent-body').evaluate((node) => { node.scrollTop = 0; });
    await page.locator('#word-input').fill(text);
    await tap(page, '#btn-save-words');
    return (await page.locator('#parent-message').innerText()).trim();
  };
  const oneDrillPotion = async (page) => {
    await startPotions(page, '#btn-drill-make10');
    const { kind } = await brewOne(page);
    await tapNext(page);
    await tap(page, '#btn-brew-quit');
    await page.waitForSelector('#screen-home:not([hidden])');
    return kind;
  };

  // ---- the reviewer's steps: the word list is refused, then a reset of the math facts is kept
  let tag = 'words not saved, facts saved';
  const first = await openPage(browser, baseUrl, SIZES[0], {
    reducedMotion: 'reduce', storage: 'picky', saved: { words, custom: true, stars: 4 },
    savedFacts: { facts: { '8+5': savedFact(1, { pace: 'slow', times: [9000], seen: 1, right: 1 }) }, speed: {} },
  });
  let page = first.page;
  await openGrownUps(page, browserName);
  check(!(await isShowing(page, '#save-note')), `${tag}: no notice while everything can be saved`);
  await refuse(page, STORE_KEY);
  let message = await saveWords(page, 'banana');
  check(/this visit only/.test(message) && !/^Saved/.test(message), `${tag}: the new word list is not called saved`, message);
  check(await isShowing(page, '#save-note'), `${tag}: the notice appears`);
  check(JSON.stringify((await readSaved(page)).words) === JSON.stringify(words), `${tag}: the old list is still what is stored`);
  await page.locator('#btn-reset-facts').evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await tap(page, '#btn-reset-facts');
  await tap(page, '#btn-reset-facts');
  check(JSON.stringify(await readFacts(page)) === '{"facts":{},"speed":{}}' && /Math facts were reset\. Stars and words are untouched/.test(await page.locator('#facts-message').innerText()),
    `${tag}: the reset of the math facts is saved, and says so`, await page.locator('#facts-message').innerText());
  check(await isShowing(page, '#save-note'), `${tag}: the notice stays, because the word list is still not saved`);
  await leaveGrownUps(page);
  check((await oneDrillPotion(page)) === 'brewed' && Object.keys((await readFacts(page)).facts).length === 1, `${tag}: a fact answer is saved as well`);
  await openGrownUps(page, browserName);
  check(await isShowing(page, '#save-note'), `${tag}: the notice is still there after playing and coming back`);
  check((await page.locator('#parent-preview .chip').allInnerTexts()).join() === 'banana' && JSON.stringify((await readSaved(page)).words) === JSON.stringify(words),
    `${tag}: the new list is used for this visit, the stored one is the old one`);
  await refuse(page, false);
  await tap(page, '#round-size [data-size="3"]');
  check(JSON.stringify((await readSaved(page)).words) === '["banana"]' && (await readSaved(page)).stars === 6, `${tag}: once the save fits again, the next change saves the word list and the stars too`, JSON.stringify(await readSaved(page)));
  check(!(await isShowing(page, '#save-note')), `${tag}: only then does the notice go away`);
  check(first.problems.length === 0, `${tag}: no errors in the browser console`, first.problems.slice(0, 3).join(' | '));
  await first.context.close();

  // ---- the other way round: the fact memory is refused, the game save is kept
  tag = 'facts not saved, words saved';
  const second = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', storage: 'picky', saved: { words, custom: true, stars: 4 } });
  page = second.page;
  await refuse(page, FACTS_KEY);
  check((await oneDrillPotion(page)) === 'brewed', `${tag}: a drill potion brews`);
  check((await readFacts(page)) === null && (await readSaved(page)).stars === 6, `${tag}: the stars were saved, the fact answer was not`, JSON.stringify(await readFacts(page)));
  await openGrownUps(page, browserName);
  check(await isShowing(page, '#save-note'), `${tag}: the notice is up, though the last save (the stars) worked`);
  check(/1 fact practiced/.test(await page.locator('#facts-summary').innerText()), `${tag}: the fact is remembered for this visit`);
  message = await saveWords(page, 'banana');
  check(/^Saved 1 word/.test(message) && JSON.stringify((await readSaved(page)).words) === '["banana"]', `${tag}: the word list is saved, and says so`, message);
  check(await isShowing(page, '#save-note'), `${tag}: the notice stays, because the math facts are still not saved`);
  await leaveGrownUps(page);
  await openGrownUps(page, browserName);
  check(await isShowing(page, '#save-note'), `${tag}: ... also after leaving the grown-ups' corner and coming back`);
  await leaveGrownUps(page);
  await refuse(page, false);
  check((await oneDrillPotion(page)) === 'brewed', `${tag}: another drill potion brews`);
  check(Object.keys((await readFacts(page)).facts).length === 2, `${tag}: once it fits again the whole fact memory is saved, the earlier answer too`, JSON.stringify(await readFacts(page)));
  await openGrownUps(page, browserName);
  check(!(await isShowing(page, '#save-note')), `${tag}: only then does the notice go away`);
  check(second.problems.length === 0, `${tag}: no errors in the browser console`, second.problems.slice(0, 3).join(' | '));
  await second.context.close();
}

// ---------------------------------------------------------------- math fix 2: a speedy brew asks only facts that are quick

async function speedyOnlyQuickFacts(browser, baseUrl) {
  let tag = 'speedy brew after a slip';
  const missed = () => savedFact(0, { due: true, miss: true, seen: 4, right: 3 });
  const neverTwiceInARow = (sums) => sums.every((sum, i) => !i || sum !== sums[i - 1]);
  const playSpeedy = async (page) => {
    const sums = [];
    for (let turn = 1; turn <= 8; turn++) sums.push((await speedyOne(page, turn)).seen.equation.join(' '));
    await page.waitForSelector('#screen-done:not([hidden])');
    return sums;
  };
  const openMenu = async (page) => {
    await tap(page, '#btn-potions');
    await page.waitForSelector('#screen-potions:not([hidden])');
    return (await page.locator('#btn-speedy-make10 .menu-sub').innerText()).trim();
  };

  // ---- the reviewer's case: earned, then two pairs missed, and 8 + 5 answered once, slowly
  const facts = seededPairs([1, 4, 5, 6, 7, 8, 9], missed);
  facts['8+5'] = savedFact(1, { pace: 'slow', times: [9000], seen: 1, right: 1 });
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { reducedMotion: 'reduce', saved: { stars: 5 }, savedFacts: { facts, speed: SPEEDY_EARNED } });
  let sub = await openMenu(page);
  check(await isShowing(page, '#btn-speedy-make10') && sub === 'Just for fun!', `${tag}: the speedy brew is still there after two pairs were missed`, sub);
  check((await page.locator('#btn-drill-make10 .menu-sub').innerText()) === '7 of 9 quick', `${tag}: the drill card says 7 of 9 are quick`);
  await tap(page, '#btn-speedy-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  check((await readHelp(page)).mode === 'speedy', `${tag}: it starts as a speedy brew`);
  let sums = await playSpeedy(page);
  check(sums.length === 8 && sums.every((sum) => /^[1456789] \+ \? = 10$/.test(sum)), `${tag}: every potion is one of the seven pairs that are quick`, sums.join(' | '));
  check(!sums.some((sum) => /^[23] \+/.test(sum)), `${tag}: the two missed pairs are left out`, sums.join(' | '));
  check(!sums.includes('8 + 5 = ?'), `${tag}: 8 + 5, which was never quick, is left out (it used to fill the round)`, sums.join(' | '));
  check(new Set(sums).size === 7 && neverTwiceInARow(sums), `${tag}: with seven quick facts one comes twice, but not twice in a row`, sums.join(' | '));
  check(/^You brewed 8 of 8 speedy potions/.test(await page.locator('#done-summary').innerText()), `${tag}: the round is 8 potions as always`);

  // ---- four quick facts are enough: each comes twice
  tag = 'speedy brew with four quick facts';
  await reopenWith(page, { facts: seededPairs([6, 7, 8, 9], missed), speed: SPEEDY_EARNED });
  sub = await openMenu(page);
  check(sub === 'Just for fun!', `${tag}: it can still be played`, sub);
  await tap(page, '#btn-speedy-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  sums = await playSpeedy(page);
  check(new Set(sums).size === 4 && sums.every((sum) => /^[6789] \+ \? = 10$/.test(sum)) && neverTwiceInARow(sums), `${tag}: the four come twice each, never twice in a row`, sums.join(' | '));

  // ---- three are too few: practice first, and the speedy brew stays earned
  tag = 'speedy brew with too few quick facts';
  const slipped = (n) => (n <= 3 ? missed() : savedFact(2, { due: true, pace: 'slow', times: [8000] }));
  await reopenWith(page, { facts: seededPairs([7, 8, 9], slipped), speed: SPEEDY_EARNED });
  sub = await openMenu(page);
  check(await isShowing(page, '#btn-speedy-make10'), `${tag}: its card is still in the menu (once earned, it stays)`);
  check(/practice first/.test(sub) && /practice first/.test(await page.locator('#btn-speedy-make10').getAttribute('aria-label')), `${tag}: the card says that a little practice comes first`, sub);
  await checkMenu(page, tag, ['make10']);
  await shot(page, '27-speedy-practice-first-portrait');
  const spokenBefore = (await spokenList(page)).length;
  await tap(page, '#btn-speedy-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  let help = await readHelp(page);
  check(help.mode === 'drill' && help.buttons.join() === 'dots,hint', `${tag}: tapping it starts a round of practice, with Dots and Hint`, `${help.mode} ${help.buttons.join()}`);
  const greeting = (await spokenList(page))[spokenBefore].text;
  check(/practice/.test(greeting) && !/speedy/i.test(greeting), `${tag}: the greeting says so, kindly`, greeting);
  sums = [];
  const withDots = [];
  for (let turn = 1; turn <= 8; turn++) {
    help = await readHelp(page);
    const { seen } = await brewOne(page);
    sums.push(seen.equation.join(' '));
    if (help.view === 'dots') withDots.push(seen.equation[0]);
    await tapNext(page);
  }
  await page.waitForSelector('#screen-done:not([hidden])');
  check(sums.slice(0, 6).map((sum) => sum[0]).sort().join('') === '123456' && sums.slice(0, 6).every((sum) => sum.endsWith('? = 10')), `${tag}: the practice asks the six pairs that slipped`, sums.join(' | '));
  check(withDots.sort().join('') === '123', `${tag}: the missed ones come with their dots`, withDots.join());
  await sleep(300);
  check(await isShowing(page, '#speedy-offer') && !/New!/.test(await page.locator('#speedy-offer-text').innerText()), `${tag}: after the practice enough facts are quick again, and the speedy brew is offered`, await page.locator('#speedy-offer-text').innerText());
  await tap(page, '#btn-offer-go');
  await page.waitForSelector('#screen-brew:not([hidden])');
  check((await readHelp(page)).mode === 'speedy', `${tag}: "Try it" starts the speedy brew`);
  sums = await playSpeedy(page);
  check(sums.every((sum) => /^[456789] \+ \? = 10$/.test(sum)), `${tag}: it asks the six that are quick now, not the three that needed their dots`, sums.join(' | '));

  // ---- none at all: practice, no offer afterwards, and still earned
  tag = 'speedy brew with no quick fact';
  await reopenWith(page, { facts: seededPairs([], missed), speed: SPEEDY_EARNED });
  sub = await openMenu(page);
  check(await isShowing(page, '#btn-speedy-make10') && /practice first/.test(sub), `${tag}: the card stays and asks for practice first`, sub);
  await tap(page, '#btn-speedy-make10');
  await page.waitForSelector('#screen-brew:not([hidden])');
  check((await readHelp(page)).mode === 'drill', `${tag}: tapping it starts practice`);
  for (let turn = 1; turn <= 8; turn++) {
    await brewOne(page);
    await tapNext(page);
  }
  await page.waitForSelector('#screen-done:not([hidden])');
  await sleep(300);
  check(!(await isShowing(page, '#speedy-offer')) && await donePanelFits(page), `${tag}: no speedy brew is offered while nothing is quick`);
  check((await readFacts(page)).speed.make10.unlocked === true, `${tag}: it stays earned all the same`);
  check(problems.length === 0, 'speedy brew after a slip: no errors in the browser console', problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- math fix 3: an answer nobody could time

// The iPad is put down and picked up again while a potion is on screen.
const putDownAndPickUp = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
});

async function untimedAnswers(browser, browserName, baseUrl) {
  const tag = 'untimed answer';
  const now = Date.now();
  // 12 + 7 was slow twenty minutes ago and is due again; 6 + 6 is in the top box and due in an hour.
  const seeded = {
    '12+7': { box: 1, due: now - 10 * MINUTE, seen: 1, right: 1, times: [9000], last: now - 20 * MINUTE, miss: false, pace: 'slow' },
    '6+6': { box: 5, due: now + HOUR, seen: 6, right: 6, times: [2000, 2100, 1900], last: now + HOUR - 16 * DAY, miss: false, pace: 'quick' },
  };
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], { reducedMotion: 'reduce', savedFacts: { facts: seeded, speed: {} } });
  const data = await page.evaluate(() => {
    const F = window.SPELLCASTER_FACTS;
    const MIN = 60 * 1000;
    const DAY = 24 * 60 * MIN;
    const t0 = 1700000000000;
    const quick = { ok: true, ms: 2500, helped: false };
    const slow = { ok: true, ms: 9000, helped: false };
    const away = { ok: true, ms: NaN, helped: false };
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const listed = (store) => F.slowList(store).map((row) => `${row.key}:${row.why}:${row.ms}:${row.right}/${row.seen}`).join();
    const out = {};

    // A slow fact, asked again five minutes later while the iPad was put down.
    let store = F.fresh();
    const before = copy(F.record(store, '12+7', slow, t0));
    const after = copy(F.record(store, '12+7', away, t0 + 5 * MIN));
    out.slow = { before, after, listed: listed(store), early: F.review(store, t0 + 6 * MIN, 8), due: F.review(store, t0 + 11 * MIN, 8), reloaded: copy(F.clean(copy(store)).facts['12+7']) };

    // A fact in the top box, an hour before its day, and then a day after it.
    const top = F.fresh();
    let at = t0;
    let f;
    for (let n = 0; n < 5; n++) {
      f = F.record(top, '6+6', quick, at);
      at = f.due + MIN;
    }
    const topBefore = copy(f);
    const early = copy(F.record(top, '6+6', away, topBefore.due - 60 * MIN));
    const reloaded = copy(F.clean(copy(top)).facts['6+6']);
    const late = copy(F.record(top, '6+6', away, topBefore.due + DAY));
    const stillDue = F.review(top, topBefore.due + DAY + MIN, 8);
    const timed = copy(F.record(top, '6+6', quick, topBefore.due + DAY + 2 * MIN));
    out.top = { before: topBefore, early, reloaded, late, stillDue, timed, gap: F.GAPS[5], at: topBefore.due + DAY + 2 * MIN };

    // An answer that took longer than a minute cannot be told from an iPad left lying: also untimed.
    store = F.fresh();
    F.record(store, '9+4', slow, t0);
    out.long = copy(F.record(store, '9+4', { ok: true, ms: 95000, helped: false }, t0 + MIN));

    // A missed fact that is then right, untimed: the miss is mended, and it is asked again soon.
    store = F.fresh();
    F.record(store, '9+4', { ok: false, ms: 2500, helped: false }, t0);
    out.mended = { f: copy(F.record(store, '9+4', away, t0 + MIN)), wait: F.get(store, '9+4').due - (t0 + MIN), listed: listed(store) };

    // With the dots or the hint an untimed answer is still an answer with help.
    store = F.fresh();
    for (let n = 0; n < 3; n++) F.record(store, '9+4', quick, t0 + n);
    out.helped = copy(F.record(store, '9+4', { ok: true, ms: NaN, helped: true }, t0 + MIN));
    out.GAP1 = F.GAPS[1];
    return out;
  });

  // ---- the fact memory itself
  const { slow, top } = data;
  check(slow.after.pace === 'slow' && slow.after.box === slow.before.box && slow.after.due === slow.before.due, `${tag}: a slow fact stays slow, in its box and due on its day`, JSON.stringify(slow.after));
  check(slow.after.seen === 2 && slow.after.right === 2 && slow.after.times.join() === '9000', `${tag}: the answer is counted as right, and no time is made up for it`, JSON.stringify(slow.after));
  check(slow.listed === '12+7:slow:9000:2/2', `${tag}: the fact stays on the slow list, with the time that was measured`, slow.listed);
  check(JSON.stringify(slow.early) === '[]' && JSON.stringify(slow.due) === '[[12,7]]', `${tag}: it is reviewed when its ten minutes are over, not put off`, `${JSON.stringify(slow.early)} ${JSON.stringify(slow.due)}`);
  check(JSON.stringify(slow.reloaded) === JSON.stringify(slow.after), `${tag}: saved and loaded again it is the same`, JSON.stringify(slow.reloaded));
  check(top.early.box === 5 && top.early.due === top.before.due && top.early.pace === 'quick' && top.early.seen === 6, `${tag}: a top-box fact asked an hour early keeps its day (it used to move 16 days on)`, `due moved by ${top.early.due - top.before.due} ms`);
  check(JSON.stringify(top.reloaded) === JSON.stringify(top.early), `${tag}: ... also after saving and loading`, JSON.stringify(top.reloaded));
  check(top.late.due === top.before.due && JSON.stringify(top.stillDue) === '[[6,6]]', `${tag}: an overdue fact stays due until an answer can be timed`, JSON.stringify(top.stillDue));
  check(top.timed.due === top.at + top.gap && top.timed.box === 5, `${tag}: the next timed answer counts as always`, JSON.stringify(top.timed));
  check(data.long.pace === 'slow' && data.long.box === 1 && data.long.times.join() === '9000', `${tag}: an answer after more than a minute is untimed too, and changes nothing`, JSON.stringify(data.long));
  check(data.mended.f.miss === false && data.mended.f.box === 1 && data.mended.f.pace === 'away' && data.mended.wait === data.GAP1 && data.mended.listed === '',
    `${tag}: a missed fact that is then right is mended, and asked again after ten minutes`, JSON.stringify(data.mended));
  check(data.helped.pace === 'helped' && data.helped.box === 1, `${tag}: an untimed answer with the dots showing still counts as helped`, JSON.stringify(data.helped));

  // ---- in the game: the iPad is put down in the middle of two potions
  await useRound(page, [['add', 12, 7], ['add', 6, 6], ['add', 2, 2]]);
  await startPotions(page);
  for (const sum of ['12 + 7 = ?', '6 + 6 = ?']) {
    const seen = await readBrew(page);
    check(seen.equation.join(' ') === sum && !(await readHelp(page)).open, `${tag}: ${sum} is asked, without help`, seen.equation.join(' '));
    await putDownAndPickUp(page);
    check((await brewOne(page)).kind === 'brewed', `${tag}: ${sum} still brews after the iPad was put down`);
    await tapNext(page);
  }
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  const check12and6 = async (when) => {
    const facts = (await readFacts(page)).facts;
    check(facts['12+7'].pace === 'slow' && facts['12+7'].box === 1 && facts['12+7'].due === seeded['12+7'].due && facts['12+7'].seen === 2 && facts['12+7'].right === 2,
      `${tag}, ${when}: 12 + 7 is still slow and still due`, JSON.stringify(facts['12+7']));
    check(facts['6+6'].box === 5 && facts['6+6'].due === seeded['6+6'].due && facts['6+6'].pace === 'quick' && facts['6+6'].seen === 7,
      `${tag}, ${when}: 6 + 6 is still due in an hour, not in 16 days`, `due moved by ${facts['6+6'].due - seeded['6+6'].due} ms`);
  };
  await check12and6('in the game');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  await openGrownUps(page, browserName);
  const rows = await page.locator('#slow-facts .fact-row').evaluateAll((nodes) => nodes.map((row) => `${row.querySelector('.fact-name').textContent} — ${row.querySelector('.fact-note').textContent}`));
  check(rows.join() === '12 + 7 — took 9 seconds · right 2 of 2', `${tag}: after a reload the grown-ups still see 12 + 7 as slow`, rows.join(' | '));
  await leaveGrownUps(page);
  await useRound(page, [['add', 2, 2]]); // one more answer, so that what was loaded is written out again
  await startPotions(page);
  check((await brewOne(page)).kind === 'brewed' && Object.keys((await readFacts(page)).facts).length === 3, `${tag}: after a reload another potion brews and the fact memory is saved again`);
  await check12and6('loaded and saved again');
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- math fix 4: spaced repeats in mixed rounds until a fact is quick

async function spacedReviewInMixedRounds(browser, baseUrl) {
  let tag = 'mixed review';
  const now = Date.now();
  const onlyAdd = Object.fromEntries(ALL_TOPICS.map((id) => [id, id === 'add']));
  // 13 + 5 belongs to no drill, and the easy level never makes it up by itself (its first number stops at 12),
  // so it can only come back through the fact memory. It was slow a quarter of an hour ago.
  const seeded = { '13+5': { box: 1, due: now - 5 * MINUTE, seen: 1, right: 1, times: [9000], last: now - 15 * MINUTE, miss: false, pace: 'slow' } };
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1], {
    reducedMotion: 'reduce', saved: { math: { level: 'easy', topics: onlyAdd, brewed: 0 } }, savedFacts: { facts: seeded, speed: {} },
  });
  const data = await page.evaluate(() => {
    const F = window.SPELLCASTER_FACTS;
    const MIN = 60 * 1000;
    const DAY = 24 * 60 * MIN;
    const t0 = 1700000000000;
    const quick = { ok: true, ms: 2500, helped: false };
    const slow = { ok: true, ms: 9000, helped: false };
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const out = {};
    // slow -> quick at the ten-minute review -> due the next day -> quick -> due three days on -> ...
    let store = F.fresh();
    F.record(store, '12+7', slow, t0);
    const second = copy(F.record(store, '12+7', quick, t0 + 11 * MIN));
    out.second = { box: second.box, wait: second.due - (t0 + 11 * MIN), pace: second.pace, quick: F.isQuick(store, '12+7'), listed: F.slowList(store).length };
    out.sameDay = F.review(store, t0 + 3 * 60 * MIN, 8);
    out.nextDay = F.review(store, second.due + MIN, 8);
    store = F.clean(copy(store)); // another day, another visit
    const third = copy(F.record(store, '12+7', quick, second.due + MIN));
    out.third = { box: third.box, wait: third.due - (second.due + MIN), quick: F.isQuick(store, '12+7') };
    out.tooSoon = F.review(store, third.due - DAY, 8);
    out.onItsDay = F.review(store, third.due + MIN, 8);
    store = F.clean(copy(store));
    const fourth = copy(F.record(store, '12+7', quick, third.due + MIN));
    out.fourth = { box: fourth.box, wait: fourth.due - (third.due + MIN) };
    out.GAPS = F.GAPS;

    // Which come first, and the limit: missed, slow, then the rest by box. A make-10 pair waits for its drill.
    store = F.fresh();
    for (let n = 0; n < 3; n++) F.record(store, '9+5', quick, t0);       // box 3
    F.record(store, '9+4', quick, t0);                                   // box 1, never slow
    for (let n = 0; n < 5; n++) F.record(store, '9+3', quick, t0 + n * 20 * DAY - 400 * DAY); // top box ...
    F.record(store, '9+3', slow, t0);                                    // ... and slow last time
    F.record(store, '9+2', { ok: false, ms: 2500, helped: false }, t0);  // missed
    F.record(store, '4+?=10', slow, t0);
    out.boxes = ['9+2', '9+3', '9+4', '9+5'].map((key) => F.boxOf(store, key)).join();
    out.order = Array.from({ length: 10 }, () => JSON.stringify(F.review(store, t0 + 4 * DAY, 8)));
    out.capped = [1, 2, 3].map((limit) => JSON.stringify(F.review(store, t0 + 4 * DAY, limit)));
    out.quickCount = [F.isQuick(store, '9+3'), F.isQuick(store, '9+5'), F.summary(store)];
    return out;
  });

  // ---- the fact memory itself
  check(data.second.box === 2 && data.second.wait === data.GAPS[2] && data.second.pace === 'quick' && data.second.quick === false && data.second.listed === 0,
    `${tag}: a slow fact answered quickly once moves up a box and off the slow list, but is not quick yet`, JSON.stringify(data.second));
  check(JSON.stringify(data.sameDay) === '[]', `${tag}: it is not asked again the same day`, JSON.stringify(data.sameDay));
  check(JSON.stringify(data.nextDay) === '[[12,7]]', `${tag}: the next day it is due and reviewed, though its last answer was quick (it used to be dropped here)`, JSON.stringify(data.nextDay));
  check(data.third.box === 3 && data.third.wait === data.GAPS[3] && data.third.quick === true, `${tag}: a second quick answer on another day makes it quick`, JSON.stringify(data.third));
  check(JSON.stringify(data.tooSoon) === '[]' && JSON.stringify(data.onItsDay) === '[[12,7]]', `${tag}: a quick fact rests for its three days, then comes back once`, `${JSON.stringify(data.tooSoon)} ${JSON.stringify(data.onItsDay)}`);
  check(data.fourth.box === 4 && data.fourth.wait === data.GAPS[4], `${tag}: ... and then waits a week: the waits keep growing`, JSON.stringify(data.fourth));
  check(data.boxes === '0,4,1,3' && new Set(data.order).size === 1 && data.order[0] === '[[9,2],[9,3],[9,4],[9,5]]',
    `${tag}: missed first, then slow (whatever its box), then the others whose wait is over, lowest box first`, `${data.order[0]} (boxes ${data.boxes})`);
  check(data.capped.join(' ') === '[[9,2]] [[9,2],[9,3]] [[9,2],[9,3],[9,4]]', `${tag}: the limit cuts the list from the end`, data.capped.join(' '));
  check(data.quickCount[0] === false && data.quickCount[1] === true && data.quickCount[2].quick === 1 && data.quickCount[2].slow === 3,
    `${tag}: a fact that was slow last time is not counted as quick, whatever its box`, JSON.stringify(data.quickCount));

  // ---- in the game, over five visits (the saved fact memory is moved back in time between them)
  const visit = async () => {
    await page.evaluate(() => {
      const P = window.SPELLCASTER_POTIONS;
      const make = P.makeRound;
      P.makeRound = (settings, count, review) => {
        window.__review = review.map((pair) => pair.join('+')).join();
        return make(settings, count, review);
      };
    });
    await startPotions(page);
    return { review: await page.evaluate(() => window.__review), first: (await readBrew(page)).equation.join(' ') };
  };
  const answerFirst = async () => {
    const { kind } = await brewOne(page);
    await tapNext(page);
    return { kind, fact: (await readFacts(page)).facts['13+5'] };
  };
  const later = async (ms) => {
    const facts = await readFacts(page);
    for (const f of Object.values(facts.facts)) {
      f.due -= ms;
      f.last -= ms;
    }
    await reopenWith(page, facts);
  };
  let seen = await visit();
  check(seen.review === '13+5' && seen.first === '13 + 5 = ?', `${tag}, visit 1: the slow fact is reviewed first`, `${seen.review} / ${seen.first}`);
  let got = await answerFirst();
  check(got.kind === 'brewed' && got.fact.box === 2 && got.fact.pace === 'quick', `${tag}, visit 1: answered quickly, it moves up to box 2`, JSON.stringify(got.fact));
  await later(2 * HOUR);
  seen = await visit();
  check(seen.review === '' && seen.first !== '13 + 5 = ?', `${tag}, two hours later: it rests (nothing to review)`, `${seen.review} / ${seen.first}`);
  await later(DAY);
  seen = await visit();
  check(seen.review === '13+5' && seen.first === '13 + 5 = ?', `${tag}, the next day: it is reviewed again, though its last answer was quick`, `${seen.review} / ${seen.first}`);
  got = await answerFirst();
  check(got.fact.box === 3 && got.fact.seen === 3 && got.fact.right === 3, `${tag}, the next day: a second quick answer makes it quick (box 3)`, JSON.stringify(got.fact));
  await later(DAY);
  seen = await visit();
  check(seen.review === '', `${tag}, a day after that: a quick fact rests for three days`, seen.review);
  await later(2 * DAY + HOUR);
  seen = await visit();
  check(seen.review === '13+5' && seen.first === '13 + 5 = ?', `${tag}, three days on: it comes back once to stay fresh`, `${seen.review} / ${seen.first}`);
  got = await answerFirst();
  check(got.fact.box === 4 && got.fact.due - Date.now() > 6 * DAY, `${tag}, three days on: answered quickly, it now waits a week`, JSON.stringify(got.fact));

  // ---- within 100 a mixed round still reviews one fact only, the one most in need; none with Adding off
  tag = 'mixed review within 100';
  const three = {
    '9+4': savedFact(2, { due: true }),
    '9+3': savedFact(1, { due: true, pace: 'slow', times: [9000] }),
    '9+2': savedFact(0, { due: true, miss: true, seen: 2, right: 1 }),
  };
  const setMath = (topics) => page.evaluate(([key, topics]) => {
    window.localStorage.setItem(key, JSON.stringify({ math: { level: 'hundred', topics, brewed: 0 } }));
  }, [STORE_KEY, topics]);
  await setMath(Object.fromEntries(ALL_TOPICS.map((id) => [id, true])));
  await reopenWith(page, { facts: three, speed: {} });
  seen = await visit();
  check(seen.review === '9+2', `${tag}: one review a round, and it is the missed fact`, seen.review);
  await setMath(Object.fromEntries(ALL_TOPICS.map((id) => [id, id !== 'add'])));
  await reopenWith(page, { facts: three, speed: {} });
  seen = await visit();
  check(seen.review === '', `${tag}: with Adding switched off nothing is reviewed`, seen.review);
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- math fix 5: the stopwatch leaves out the voice

async function stopwatchLeavesOutTheVoice(browser, baseUrl) {
  let tag = 'stopwatch';
  const LASTS = 1500; // every sentence takes this long here, like a real voice
  const THINK = 4000;
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', clock: true, speech: { lasts: LASTS } });
  const talking = () => page.evaluate(() => window.__talking);
  const quiet = () => page.waitForFunction(() => !window.__talking, null, { timeout: 10000 });
  const think = (ms) => page.evaluate((ms) => window.__wait(ms), ms);
  const timeOf = async (key) => {
    const f = (await readFacts(page)).facts[key];
    return f ? { ms: f.times[f.times.length - 1], pace: f.pace, times: f.times.length } : { ms: -1, pace: 'not saved', times: 0 };
  };
  // A little slack for the taps themselves; the old stopwatch was a whole sentence or more over.
  const about = (time, ms) => time.ms >= ms && time.ms < ms + 1300;

  await useRound(page, [['add', 9, 4], ['add', 8, 3], ['add', 7, 5], ['add', 6, 3], ['add', 5, 4], ['add', 4, 3]]);
  const before = Date.now();
  await startPotions(page);
  check(await talking(), `${tag}: the greeting is being spoken while the first potion is already on screen`);
  await quiet();
  const listened = Date.now() - before;
  check(listened >= 2 * LASTS - 200, `${tag}: the greeting and the first question take their time here`, `${listened} ms`);
  const said = (await spokenList(page)).slice(-2).map((s) => s.text);
  check(/brew some potions/.test(said[0]) && said[1] === 'What is 9 plus 4?', `${tag}: (they are the greeting and the question)`, said.join(' | '));
  await think(THINK);
  await brewOne(page);
  const first = await timeOf('9+4');
  check(about(first, THINK) && first.pace === 'quick', `${tag}: the first potion is timed from when the voice is done, so four seconds of thinking is a quick answer`, JSON.stringify(first));
  await tapNext(page);

  await quiet();
  await think(THINK);
  await brewOne(page);
  const second = await timeOf('8+3');
  check(about(second, THINK) && second.pace === 'quick', `${tag}: a later potion is timed the same way`, JSON.stringify(second));
  check(Math.abs(second.ms - first.ms) < 800, `${tag}: the first potion and a later one get the same time for the same thinking`, `${first.ms} ms and ${second.ms} ms`);
  await tapNext(page);

  // An answer before the voice is done.
  await tapDigits(page, '12');
  check(await talking(), `${tag}: (the third question is still being read)`);
  check((await brewAndSeeResult(page)) === 'brewed', `${tag}: a potion can be brewed while the question is still being read`);
  const third = await timeOf('7+5');
  check(third.times === 1 && third.ms >= 1 && third.ms < 1000 && third.pace === 'quick', `${tag}: such an answer is a quick one, not one that could not be timed`, JSON.stringify(third));
  await tapNext(page);

  // "Hear it again" and "Slowly" in the middle of thinking.
  for (const [button, key, name] of [['#btn-brew-hear', '6+3', 'Hear it again'], ['#btn-brew-slow', '5+4', 'Slowly']]) {
    await quiet();
    await think(THINK / 2);
    await tap(page, button);
    check(await talking(), `${tag}: "${name}" reads the question once more`);
    await quiet();
    await think(THINK / 2);
    await brewOne(page);
    const again = await timeOf(key);
    check(about(again, THINK) && again.pace === 'quick', `${tag}: listening with "${name}" is not counted as thinking, the time before and after it is`, JSON.stringify(again));
    await tapNext(page);
  }

  // A browser that never says the sentence is over.
  await page.evaluate(() => { window.__speechLasts = 'forever'; });
  await tap(page, '#btn-brew-hear');
  await sleep(100);
  check(await talking(), `${tag}: (this sentence never ends)`);
  await think(20000);
  await brewOne(page);
  const stuck = await timeOf('4+3');
  check(stuck.pace === 'slow' && stuck.ms >= 12000 && stuck.ms < 20000, `${tag}: a voice that never reports the end cannot stop the stopwatch for good: twenty seconds is still slow`, JSON.stringify(stuck));
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();

  // ---- without a voice, and with one that fails, the potion is timed from the moment it appears
  for (const [name, speech] of [['no voice', 'none'], ['a voice that fails', { lasts: LASTS, error: 'not-allowed' }]]) {
    tag = `stopwatch, ${name}`;
    const plain = await openPage(browser, baseUrl, SIZES[1], { reducedMotion: 'reduce', clock: true, speech });
    await useRound(plain.page, [['add', 9, 4], ['add', 2, 2]]);
    await startPotions(plain.page);
    await sleep(150);
    await plain.page.evaluate((ms) => window.__wait(ms), THINK);
    check((await brewOne(plain.page)).kind === 'brewed', `${tag}: the potion brews`);
    const f = (await readFacts(plain.page)).facts['9+4'];
    check(f.pace === 'quick' && f.times[0] >= THINK && f.times[0] < THINK + 1300, `${tag}: four seconds of thinking are four seconds`, JSON.stringify(f));
    check(plain.problems.length === 0, `${tag}: no errors in the browser console`, plain.problems.slice(0, 3).join(' | '));
    await plain.context.close();
  }
}

// ---------------------------------------------------------------- math fix 6: speedy potions count as brewed

async function speedyPotionsCount(browser, browserName, baseUrl) {
  const tag = 'speedy potions counted';
  const { context, page, problems } = await openPage(browser, baseUrl, SIZES[0], {
    reducedMotion: 'reduce', saved: { stars: 5, math: { brewed: 5 } }, savedFacts: { facts: seededPairs([1, 2, 3, 4, 5, 6, 7, 8, 9]), speed: SPEEDY_EARNED },
  });
  const brewedSaved = async () => (await readSaved(page)).math.brewed;
  const homeLine = async () => (await page.locator('#potions-status').innerText()).trim();
  check((await homeLine()) === '5 potions brewed', `${tag}: five potions were brewed before`, await homeLine());

  // ---- a speedy brew with three potions missed: the five that worked are counted
  await startPotions(page, '#btn-speedy-make10');
  for (let turn = 1; turn <= 8; turn++) {
    await speedyOne(page, turn, { miss: turn <= 3 });
    if (turn === 7) check((await readSaved(page)).math.brewed === 5, `${tag}: nothing is counted before the speedy brew is finished`);
  }
  await page.waitForSelector('#screen-done:not([hidden])');
  check(/^You brewed 5 of 8 speedy potions/.test(await page.locator('#done-summary').innerText()), `${tag}: the end card says 5 of 8`, await page.locator('#done-summary').innerText());
  check((await brewedSaved()) === 10, `${tag}: the five that were brewed are added to the saved count, the three misses are not`, String(await brewedSaved()));
  await tap(page, '#btn-done-home');
  check((await homeLine()) === '10 potions brewed', `${tag}: the home screen shows them`, await homeLine());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await homeLine()) === '10 potions brewed' && (await brewedSaved()) === 10, `${tag}: also after a reload`, await homeLine());

  // ---- a second one with every potion right, then one that is left in the middle
  await startPotions(page, '#btn-speedy-make10');
  for (let turn = 1; turn <= 8; turn++) await speedyOne(page, turn);
  await page.waitForSelector('#screen-done:not([hidden])');
  check((await brewedSaved()) === 18, `${tag}: a second speedy brew adds its eight, once`, String(await brewedSaved()));
  await tap(page, '#btn-again');
  await page.waitForSelector('#screen-brew:not([hidden])');
  check((await brewedSaved()) === 18, `${tag}: "Play again" does not count the finished round a second time`, String(await brewedSaved()));
  await speedyOne(page, 1);
  await speedyOne(page, 2);
  await tap(page, '#btn-brew-quit');
  await page.waitForSelector('#screen-home:not([hidden])');
  check((await brewedSaved()) === 18 && (await homeLine()) === '18 potions brewed', `${tag}: a speedy brew left in the middle changes nothing`, await homeLine());
  await openGrownUps(page, browserName);
  check(/18 potions brewed/.test(await page.locator('#parent-progress').innerText()), `${tag}: the grown-ups' corner shows the same count`, await page.locator('#parent-progress').innerText());
  check(problems.length === 0, `${tag}: no errors in the browser console`, problems.slice(0, 3).join(' | '));
  await context.close();
}

// ---------------------------------------------------------------- run

const scenarios = [
  ...SIZES.map((size) => [`whole game, ${size.name} ${size.width}x${size.height}`, (b, name, url) => fullGame(b, name, url, size)]),
  ['tight screens and tricky words', (b, name, url) => tightLayouts(b, url)],
  ['device without speech', (b, name, url) => withoutSpeech(b, url)],
  ['reduced motion', (b, name, url) => calmMode(b, url)],
  ['potions recipes: thousands of generated problems', (b, name, url) => potionRecipes(b, url)],
  ...SIZES.map((size) => [`potions whole round, ${size.name} ${size.width}x${size.height}`, (b, name, url) => potionsRound(b, url, size)]),
  ['potions settings in the grown-ups corner', (b, name, url) => potionsSettings(b, name, url)],
  ['potions on tight screens with the trickiest pictures', (b, name, url) => potionsTight(b, url)],
  ['potions without speech and without motion', (b, name, url) => potionsQuiet(b, url)],
  // One scenario for each finding of the independent review (REVIEW.md).
  ['review 1: only on-device voices ever speak', (b, name, url) => localVoicesOnly(b, name, url)],
  ['review 2: a voice that fails leaves a clue on screen', (b, name, url) => speechFailures(b, url)],
  ['review 3: a missed word comes back within a few turns', (b, name, url) => retryGap(b, url)],
  ['review 4: the word "constructor" climbs the ladder', (b, name, url) => constructorWord(b, name, url)],
  ['review 5: no voice on every iPad size, nothing clipped', (b, name, url) => compactNoVoice(b, url)],
  ['review 6: potions easy skip counting stays within 20', (b, name, url) => easySkipRound(b, url)],
  ['review 7: a save that fails is not called saved', (b, name, url) => failedSave(b, name, url)],
  ['review 8: long words stay inside their card', (b, name, url) => longWords(b, url)],
  ['review 9: a keyboard cannot enter answers', (b, name, url) => keyboardCannotAnswer(b, url)],
  // The one finding the second review (REVIEW2.md) sent back.
  ['review 2 again: a failed voice stays failed when the voice list is refreshed', (b, name, url) => voiceListRefresh(b, name, url)],
  // The math fluency update (MATH-BRIEF.md): `npm test -- math` runs just these.
  ['math facts: boxes, spaced repeats and the drill recipes', (b, name, url) => factMemory(b, url)],
  ['math helpers: ten-frames and the counting-on hint on every iPad size', (b, name, url) => factHelpers(b, url)],
  ['math drills: Make 10 and Doubles from the Potions menu', (b, name, url) => factDrills(b, url)],
  ['math speedy brew: offered only when earned, gentle and optional', (b, name, url) => speedyBrews(b, name, url)],
  ['math slow facts and their reset in the grown-ups corner', (b, name, url) => factsForGrownUps(b, name, url)],
  ['math update keeps a save from before it: words, stars and spelling', (b, name, url) => oldSaveSurvives(b, name, url)],
  // One scenario for each finding of the independent math review (mathup/REVIEW-MATH.md): `npm test -- "math fix"`.
  ['math fix 1: a save that works does not hide another that failed', (b, name, url) => partlyFailedSave(b, name, url)],
  ['math fix 2: a speedy brew asks only facts that are quick', (b, name, url) => speedyOnlyQuickFacts(b, url)],
  ['math fix 3: an answer nobody could time changes nothing', (b, name, url) => untimedAnswers(b, name, url)],
  ['math fix 4: mixed rounds keep reviewing a fact until it is quick, and after', (b, name, url) => spacedReviewInMixedRounds(b, url)],
  ['math fix 5: the stopwatch leaves out the voice', (b, name, url) => stopwatchLeavesOutTheVoice(b, url)],
  ['math fix 6: speedy potions count as brewed', (b, name, url) => speedyPotionsCount(b, name, url)],
];

fs.mkdirSync(SHOTS, { recursive: true });
const only = process.argv[2];
const { server, url } = await startServer(0);
const started = Date.now();
let browser;
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  console.log(`Spellcaster Academy tests — ${launched.name} ${browser.version()}`);
  for (const [name, run] of scenarios) {
    if (only && !name.includes(only)) continue;
    const before = failures.length;
    console.log(`\n▸ ${name}`);
    try {
      await run(browser, launched.name, url);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.log(`    ✗ stopped early: ${err.message}`);
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.screenshot({ path: path.join(SHOTS, `FAILED-${name.replace(/[^a-z0-9]+/gi, '-')}.png` ) }).catch(() => {});
        }
        await context.close().catch(() => {});
      }
    }
    if (failures.length === before) console.log('    ✓ all good');
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.log(`\n${failures.length} of ${checks} checks FAILED (${seconds}s):`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${checks} checks passed in ${seconds}s. Screenshots are in screenshots/.`);
