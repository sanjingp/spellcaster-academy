// Spellcaster Academy — fact memory: how well each addition fact is known.
// Plain data and pure functions only (nothing here touches the page or the storage).
// game.js keeps the store in localStorage under a key of its own, next to the
// spelling save and never inside it.
//
// Every fact sits in a box, like flash cards in a Leitner box:
//   box 0   missed last time, so it comes straight back
//   box 1+  answered right. A quick answer moves it up a box, and the higher the
//           box, the longer the wait before it is due again (GAPS).
// A slow answer, or one that needed the dots or the hint, moves it back down and
// brings it back soon. That way slow and missed facts come round more often than
// the easy ones.
window.SPELLCASTER_FACTS = (() => {
  'use strict';

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const GAPS = [0, 10 * MINUTE, DAY, 3 * DAY, 7 * DAY, 16 * DAY]; // the wait in each box
  const TOP_BOX = GAPS.length - 1;
  const QUICK_BOX = 3;    // a fact in this box or higher is "quick": right and fast several times
  const QUICK_MS = 6000;  // right within this, without the dots or the hint, is a quick answer
  const AWAY_MS = 60000;  // longer than this is not thinking time: the iPad was put down
  const KEEP_TIMES = 5;   // how many answer times are remembered for each fact
  const MAX_FACTS = 400;
  const MAX_RUN_MS = 60 * MINUTE; // no speedy brew takes longer than this
  const KEY = /^(\d{1,2})\+(?:(\d{1,2})|\?=10)$/; // "8+5", or "7+?=10" for a make-10 pair
  const PACES = ['quick', 'slow', 'helped', 'away'];

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const whole = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const okTime = (ms) => Number.isFinite(ms) && ms > 0 && ms <= AWAY_MS;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  // Stores have no prototype, so whatever a damaged save holds can never be mistaken for a fact.
  //   facts – key -> { box, due, seen, right, times, last, miss, pace }
  //           due and last are times (ms): when it is due again, and when it was last asked
  //   speed – drill id -> { unlocked, plays, best: { right, total, ms } | null }
  function fresh() {
    return { facts: Object.create(null), speed: Object.create(null) };
  }

  const cleanRun = (run) => (run && typeof run === 'object' && whole(run.ms) > 0 && run.ms <= MAX_RUN_MS && whole(run.total) > 0
    ? { right: Math.min(whole(run.right), whole(run.total)), total: whole(run.total), ms: whole(run.ms) }
    : null);

  // Turns whatever was saved into a store that is safe to use. Never throws.
  function clean(saved) {
    const store = fresh();
    if (!saved || typeof saved !== 'object') return store;
    if (saved.facts && typeof saved.facts === 'object') {
      let kept = 0;
      for (const [key, f] of Object.entries(saved.facts)) {
        if (kept >= MAX_FACTS) break;
        if (!KEY.test(key) || !f || typeof f !== 'object' || !whole(f.seen)) continue;
        const miss = f.miss === true;
        const box = miss ? 0 : clamp(whole(f.box), 1, TOP_BOX);
        store.facts[key] = {
          box,
          due: Math.min(whole(f.due), whole(f.last) + GAPS[box]), // never further off than its box allows
          seen: whole(f.seen),
          right: Math.min(whole(f.seen), whole(f.right)),
          times: (Array.isArray(f.times) ? f.times : []).filter(okTime).slice(-KEEP_TIMES).map(Math.round),
          last: whole(f.last),
          miss,
          pace: PACES.includes(f.pace) ? f.pace : 'away',
        };
        kept += 1;
      }
    }
    if (saved.speed && typeof saved.speed === 'object') {
      for (const [id, s] of Object.entries(saved.speed)) {
        if (!/^[a-z0-9]{1,20}$/.test(id) || !s || typeof s !== 'object') continue;
        store.speed[id] = { unlocked: s.unlocked === true, plays: whole(s.plays), best: cleanRun(s.best) };
      }
    }
    return store;
  }

  const get = (store, key) => (own(store.facts, key) ? store.facts[key] : null);
  const boxOf = (store, key) => (get(store, key) ? get(store, key).box : -1); // -1: never asked

  // Due again? (A clock that was set back must not hide a fact for good.)
  const isDue = (f, now) => now >= f.due || now < f.last;
  // Slow or missed last time: these are the facts a grown-up is shown.
  const needsWork = (f) => f.miss || f.pace === 'slow' || f.pace === 'helped';
  // Quick: right and fast several times, and not slow the last time it was asked.
  const quickFact = (f) => f.box >= QUICK_BOX && !needsWork(f);
  const isQuick = (store, key) => !!get(store, key) && quickFact(get(store, key));
  const quickCount = (store, keys) => keys.filter((key) => isQuick(store, key)).length;

  // The usual time for a right answer (the middle one of the last few), or null.
  function typical(f) {
    if (!f.times.length) return null;
    const sorted = f.times.slice().sort((x, y) => x - y);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  // Writes down one answer: { ok, ms, helped }.
  //   ms     – how long it took; NaN if nobody can tell (the iPad was put down)
  //   helped – the dots or the hint were showing
  function record(store, key, answer, now) {
    if (!KEY.test(key)) return null;
    let f = get(store, key);
    if (!f) {
      if (Object.keys(store.facts).length >= MAX_FACTS) return null;
      f = store.facts[key] = { box: 0, due: 0, seen: 0, right: 0, times: [], last: 0, miss: false, pace: 'away' };
    }
    const due = isDue(f, now);
    let wait = true; // false: nothing new was learned about the fact, so it keeps the day it was due
    f.seen += 1;
    if (!answer.ok) {
      f.box = 0;
      f.miss = true;
    } else {
      const timed = okTime(answer.ms);
      const known = f.box > 0; // it was right the last time it was asked
      f.right += 1;
      f.miss = false;
      if (known && !timed && !answer.helped) {
        // Right, but nobody could time it. That says nothing about how quick the
        // fact is, so only the count goes up: its box, the day it is due and what
        // it was last time (slow, say) all stay as they are.
        wait = false;
      } else {
        f.pace = answer.helped ? 'helped' : !timed ? 'away' : answer.ms <= QUICK_MS ? 'quick' : 'slow';
        if (f.pace === 'quick') {
          // While a fact is being learned every quick answer counts. After that it must
          // be due first, so one long sitting cannot push a fact weeks away.
          if (f.box < QUICK_BOX || due) f.box = Math.min(TOP_BOX, f.box + 1);
          else wait = false;
        } else if (f.pace === 'slow') {
          f.box = Math.max(1, f.box - 1);
        } else {
          f.box = 1; // helped, or a first right answer that nobody could time: back soon
        }
        if (f.pace === 'quick' || f.pace === 'slow') f.times = f.times.concat(Math.round(answer.ms)).slice(-KEEP_TIMES);
      }
    }
    // A slow answer only costs one box, but the fact is checked again soon.
    if (wait) f.due = now + GAPS[f.pace === 'slow' && !f.miss ? 1 : f.box];
    f.last = now;
    return f;
  }

  // Puts facts in the order they need practice: missed ones, then the ones that
  // are due (lowest box first), then new ones, then the ones that can wait.
  function rank(store, keys, now) {
    const need = (key) => {
      const f = get(store, key);
      if (!f) return [2, 0, 0];
      if (f.miss) return [0, f.last, 0];
      if (isDue(f, now)) return [1, f.box, f.last];
      return [3, f.box, f.due];
    };
    return keys
      .map((key) => ({ key, need: need(key), luck: Math.random() }))
      .sort((x, y) => x.need[0] - y.need[0] || x.need[1] - y.need[1] || x.need[2] - y.need[2] || x.luck - y.luck)
      .map((entry) => entry.key);
  }

  // Addition facts whose wait is over, as [a, b]: the ones that were missed or slow
  // last time first, then the others, lowest box first. A mixed round asks these in
  // place of fresh sums. One quick answer does not end it: a fact keeps coming back
  // on its day, after short waits while it is learned and long ones once it is quick.
  function review(store, now, limit) {
    const due = Object.keys(store.facts).filter((key) => KEY.exec(key)[2] !== undefined && isDue(store.facts[key], now));
    const [first, rest] = [true, false].map((work) => due.filter((key) => needsWork(store.facts[key]) === work));
    return rank(store, first, now).concat(rank(store, rest, now)).slice(0, limit).map((key) => key.split('+').map(Number));
  }

  // For the grown-ups: every slow or missed fact, the ones most in need first.
  //   why – 'missed', 'helped' (needed the dots or the hint) or 'slow'
  //   ms  – how long the slow answer took (null for the other two)
  function slowList(store) {
    const rows = [];
    for (const key of Object.keys(store.facts)) {
      const f = store.facts[key];
      if (!needsWork(f)) continue;
      const why = f.miss ? 'missed' : f.pace;
      rows.push({ key, why, ms: why === 'slow' ? f.times[f.times.length - 1] : null, seen: f.seen, right: f.right, last: f.last });
    }
    const order = { missed: 0, helped: 1, slow: 2 };
    return rows.sort((x, y) => order[x.why] - order[y.why] || (y.ms || 0) - (x.ms || 0) || y.last - x.last);
  }

  function summary(store) {
    const all = Object.keys(store.facts).map((key) => store.facts[key]);
    return {
      practiced: all.length,
      quick: all.filter(quickFact).length,
      slow: all.filter(needsWork).length,
    };
  }

  // ---------- speedy brews: an optional quick round, once a drill's facts are quick ----------
  const speedOf = (store, id) => (own(store.speed, id) ? store.speed[id] : null);
  const isUnlocked = (store, id) => !!(speedOf(store, id) && speedOf(store, id).unlocked);

  // Once unlocked it stays unlocked, whatever happens to the facts later.
  function unlock(store, id) {
    if (isUnlocked(store, id)) return false;
    const speedy = speedOf(store, id) || (store.speed[id] = { unlocked: false, plays: 0, best: null });
    speedy.unlocked = true;
    return true;
  }

  // Writes down a finished speedy brew: { right, total, ms }. More potions brewed
  // beats fewer; with the same number, the faster run wins.
  // Returns { best: is this a new personal best?, previous: the best before, or null }.
  function saveRun(store, id, run) {
    unlock(store, id);
    const speedy = speedOf(store, id);
    const previous = speedy.best;
    const best = !previous || run.right > previous.right || (run.right === previous.right && run.ms < previous.ms);
    speedy.plays += 1;
    if (best) speedy.best = { right: run.right, total: run.total, ms: Math.round(run.ms) };
    return { best, previous };
  }

  return {
    GAPS, QUICK_BOX, QUICK_MS, AWAY_MS,
    fresh, clean, get, boxOf, isQuick, quickCount, typical, record, rank, review, slowList, summary,
    speedOf, isUnlocked, unlock, saveRun,
  };
})();
