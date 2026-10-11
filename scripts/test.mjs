// End-to-end test for Spellcaster Academy.
// Plays the game the way a child would (taps only) at iPad sizes, in both
// orientations, and saves screenshots to screenshots/.
//
//   npm test
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
function speechStub() {
  const spoken = [];
  const voice = (name, lang) => ({ name, lang, voiceURI: name, localService: true, default: false });
  const voices = [
    voice('Albert', 'en-US'),
    voice('Daniel', 'en-GB'),
    voice('Thomas', 'fr-FR'),
    voice('Samantha', 'en-US'),
    voice('Fred', 'en-US'),
  ];
  window.__spoken = spoken;
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
      });
      setTimeout(() => utterance.onend && utterance.onend({}), 30);
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

async function openPage(browser, baseUrl, size, { speech = 'stub', saved = null, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    hasTouch: true,
    reducedMotion,
  });
  if (speech === 'stub') await context.addInitScript(speechStub);
  if (speech === 'none') await context.addInitScript(removeSpeech);
  if (saved) {
    await context.addInitScript(([key, value]) => {
      if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
    }, [STORE_KEY, JSON.stringify(saved)]);
  }
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
    let box = node.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) {
      node.scrollIntoView({ block: 'center' });
      box = node.getBoundingClientRect();
    }
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit))) {
      return { error: `it is covered by <${hit ? hit.tagName.toLowerCase() : 'nothing'} class="${hit ? hit.className : ''}">` };
    }
    return { x, y };
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

// Every tap target on the play screen must be big enough for small fingers,
// on screen, and the rows must not overlap each other.
async function checkPlayLayout(page, label) {
  const report = await page.evaluate((minTap) => {
    const problems = [];
    const visible = (node) => node.offsetParent !== null;
    const targets = [...document.querySelectorAll('#screen-play button')].filter(visible);
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
    const rows = ['.topbar', '.stage', '#slots', '#tiles', '.actions']
      .map((sel) => ({ sel, box: document.querySelector(`#screen-play ${sel}`).getBoundingClientRect() }));
    rows.forEach((row, i) => {
      if (row.box.left < -0.5 || row.box.right > window.innerWidth + 0.5) problems.push(`${row.sel} is wider than the screen`);
      if (i && row.box.top < rows[i - 1].box.bottom - 1) {
        problems.push(`${row.sel} overlaps ${rows[i - 1].sel} by ${Math.round(rows[i - 1].box.bottom - row.box.top)}px`);
      }
    });
    for (const slot of document.querySelectorAll('#slots .slot')) {
      const box = slot.getBoundingClientRect();
      if (box.left < -0.5 || box.right > window.innerWidth + 0.5) { problems.push('a letter slot is off screen'); break; }
    }
    const last = rows[rows.length - 1].box;
    if (last.bottom > window.innerHeight + 0.5) problems.push('the Cast button row is below the screen');
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('the page scrolls sideways');
    return problems;
  }, MIN_TAP);
  check(report.length === 0, `${label}: play screen layout is tidy`, report.slice(0, 4).join('; '));
}

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

// ---------------------------------------------------------------- scenario: the whole game

async function fullGame(browser, browserName, baseUrl, size) {
  const tag = size.name;
  const { context, page, problems, requests } = await openPage(browser, baseUrl, size);
  const starter = await page.evaluate(() => window.SPELLCASTER_DATA.starterWords.slice());

  // ---- home
  await sleep(500);
  await shot(page, `01-home-${tag}`);
  check(starter.length >= 10 && starter.length <= 14, `${tag}: starter list has about 12 words`, String(starter.length));
  check((await spokenList(page)).length === 0, `${tag}: nothing is spoken before Start is tapped`);
  const startBox = await page.locator('#btn-start').boundingBox();
  check(startBox.width >= 200 && startBox.height >= 90, `${tag}: Start is a big button`, `${startBox.width}x${startBox.height}`);
  const homeFits = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#screen-home button, #screen-home .logo')].map((n) => n.getBoundingClientRect());
    return boxes.every((b) => b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth);
  });
  check(homeFits, `${tag}: home screen fits on the iPad`);

  // ---- Start unlocks speech
  await tap(page, '#btn-start');
  await page.waitForSelector('#screen-play:not([hidden])');
  let spoken = await spokenList(page);
  check(spoken.length >= 2, `${tag}: speechSynthesis.speak was called after tapping Start`, `calls: ${spoken.length}`);
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
      check(gap >= 2, `${tag}: a missed word is re-queued a few turns later`, `"${word}" came back after ${gap} other turn(s)`);
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
  await tap(page, '#btn-start');
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
      await tap(page, '#btn-start');
      await page.waitForSelector('#screen-play:not([hidden])');
      const turn = await readTurn(page, [item.word]);
      check(turn.step === item.step, `${size.name}: saved step is used (${item.label})`, String(turn.step));
      if (item.step === 4) {
        check(turn.tiles.length === 27 && turn.tiles.some((t) => t.ch === "'"), `${size.name}: apostrophe tile appears for contractions`);
      }
      await tapLetters(page, planTaps(turn, false));
      await sleep(300);
      await checkPlayLayout(page, `${size.name} (${item.label})`);
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
  await tap(page, '#btn-start');
  await page.waitForSelector('#screen-play:not([hidden])');
  check(await isShowing(page, '#screen-play [data-speech-note]'), 'no speech: play screen shows a friendly note');
  check(!(await isShowing(page, '#btn-hear')), 'no speech: the Hear button is hidden');
  check(await isShowing(page, '#btn-peek'), 'no speech: a Peek button is offered instead');
  let turn = await readTurn(page, ['magic']);
  check(turn.model === 'magic', 'no speech: the word flashes at the start of the turn', String(turn.model));
  await sleep(300);
  await shot(page, '10-no-speech-peek-portrait');
  await page.waitForSelector('#model', { state: 'hidden', timeout: 5000 });
  check(true, 'no speech: the flashed word hides again');
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
  await tap(real.page, '#btn-start');
  await real.page.waitForSelector('#screen-play:not([hidden])');
  await sleep(1700);
  const voices = await real.page.evaluate(() => ('speechSynthesis' in window && window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1));
  if (voices <= 0) {
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
  await tap(page, '#btn-start');
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

// ---------------------------------------------------------------- run

const scenarios = [
  ...SIZES.map((size) => [`whole game, ${size.name} ${size.width}x${size.height}`, (b, name, url) => fullGame(b, name, url, size)]),
  ['tight screens and tricky words', (b, name, url) => tightLayouts(b, url)],
  ['device without speech', (b, name, url) => withoutSpeech(b, url)],
  ['reduced motion', (b, name, url) => calmMode(b, url)],
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
