// End-to-end test for Spellcaster Academy.
// Plays both modes — Spells (spelling) and Potions (math) — the way a child
// would (taps only) at iPad sizes, in both orientations, and saves screenshots
// to screenshots/.
//
//   npm test              everything
//   npm test -- potions   only the scenarios with "potions" in their name
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
function speechStub(setup) {
  const spoken = [];
  const voices = (setup.voices || [
    ['Albert', 'en-US', true],
    ['Daniel', 'en-GB', true],
    ['Thomas', 'fr-FR', true],
    ['Samantha', 'en-US', true],
    ['Fred', 'en-US', true],
  ]).map(([name, lang, localService]) => ({ name, lang, voiceURI: name, localService, default: false }));
  window.__spoken = spoken;
  window.__speechError = setup.error || null;
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
      setTimeout(() => {
        if (error) {
          if (utterance.onerror) utterance.onerror({ error: error === 'no-code' ? undefined : error });
          return;
        }
        if (utterance.onstart) utterance.onstart({});
        setTimeout(() => utterance.onend && utterance.onend({}), 20);
      }, 10);
    },
    cancel() {},
    pause() {},
    resume() {},
    addEventListener() {},
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
// A test can let writes through again with window.__storageFull = false.
function fullStorage() {
  const write = Storage.prototype.setItem;
  window.__storageFull = true;
  Storage.prototype.setItem = function setItem(...args) {
    if (window.__storageFull) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return write.apply(this, args);
  };
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
// storage: 'full' or 'blocked' to make saving fail
async function openPage(browser, baseUrl, size, { speech = 'stub', saved = null, reducedMotion = 'no-preference', storage = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: true,
    reducedMotion,
  });
  if (speech === 'stub') await context.addInitScript(speechStub, {});
  else if (speech === 'none') await context.addInitScript(removeSpeech);
  else if (speech !== 'real') await context.addInitScript(speechStub, speech);
  if (saved) {
    await context.addInitScript(([key, value]) => {
      if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
    }, [STORE_KEY, JSON.stringify(saved)]);
  }
  if (storage === 'full') await context.addInitScript(fullStorage);
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
  if (seen.show === 'equation') {
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

  // Turns a recipe into what readBrew() would see on screen, so the same solver checks both.
  const asSeen = (problem) => {
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
  };

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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
    await tap(page, '#btn-potions');
    await page.waitForSelector('#screen-brew:not([hidden])');
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
    await tap(page, '#btn-potions');
    await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(real.page, '#btn-potions');
  await real.page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(calm.page, '#btn-potions');
  await calm.page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
    await tap(page, '#btn-potions');
    await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
  await tap(page, '#btn-potions');
  await page.waitForSelector('#screen-brew:not([hidden])');
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
