// Spellcaster Academy — potion recipes: 2nd-grade math problems, fact drills and silly brew results.
// Plain data and pure functions only (nothing here touches the page); game.js does the brewing.
window.SPELLCASTER_POTIONS = (() => {
  'use strict';

  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const tenPhrase = (n) => (n === 1 ? '1 ten' : `${n} tens`);
  const total = (list) => list.reduce((sum, n) => sum + n, 0);
  const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Keeps rolling numbers until they fit the rule; `spare` is used if luck runs out.
  function roll(make, fits, spare) {
    for (let tries = 0; tries < 80; tries++) {
      const value = make();
      if (fits(value)) return value;
    }
    return spare;
  }

  // Math levels a grown-up can choose: 'easy' stays within 20, 'hundred' goes up to 100.
  const levels = ['easy', 'hundred'];

  // Topics a grown-up can switch on and off. `color` is the potion in the cauldron.
  const topics = [
    { id: 'add', name: 'Adding', icon: '➕', color: '#ff6fb5' },
    { id: 'sub', name: 'Taking away', icon: '➖', color: '#5bc0f8' },
    { id: 'place', name: 'Tens and ones', icon: '🔟', color: '#6fdc8c' },
    { id: 'skip', name: 'Skip counting', icon: '🐸', color: '#ffa94d' },
    { id: 'story', name: 'Story problems', icon: '📖', color: '#a78bfa' },
    { id: 'time', name: 'Telling time', icon: '🕒', color: '#2ec4b6' },
    { id: 'coins', name: 'Coins', icon: '💰', color: '#ffd75e' },
  ];

  // Drills: one family of addition facts at a time, chosen from the Potions menu.
  // They are not topics: a grown-up does not switch them on or off, and a mixed round never draws from them.
  const drills = [
    { id: 'make10', name: 'Make 10', icon: '🎯', color: '#ff9f43', teaser: 'What goes with 7?' },
    { id: 'doubles', name: 'Doubles', icon: '🍒', color: '#6c8cff', teaser: '6 + 6, then 6 + 7' },
  ];

  // Subtracting practice: two kinds, each its own button and its own round.
  // A mixed round never draws from them, and a round never mixes the two kinds.
  // `retries` is how many gentle hints she gets on one try before the potion fizzles.
  const practices = [
    { id: 'tens', name: 'Subtract tens', icon: '🔟', color: '#3aa0e8', teaser: 'Like 80 − 60', hello: 'Let’s subtract tens!' },
    { id: 'borrow', name: 'Borrow', icon: '🧱', color: '#b56bff', teaser: 'Like 52 − 27', hello: 'Let’s borrow!' },
  ];

  // Short story problems, one sentence per line. Every number is 2 or more, so
  // the plurals are always right. Taking-away stories end with "... are left?".
  const stories = [
    { op: '+', emoji: '🐸', lines: (a, b) => [`A witch has ${a} frogs.`, `She finds ${b} more.`, 'How many frogs now?'] },
    { op: '+', emoji: '🦇', lines: (a, b) => [`${a} bats sleep in the tower.`, `${b} more bats fly in.`, 'How many bats now?'] },
    { op: '+', emoji: '🍓', lines: (a, b) => [`You pick ${a} red berries`, `and ${b} blue berries.`, 'How many berries in all?'] },
    { op: '+', emoji: '🎃', lines: (a, b) => [`${a} pumpkins grow in the garden.`, `${b} more pop up.`, 'How many pumpkins now?'] },
    { op: '+', emoji: '🐲', lines: (a, b) => [`A dragon has ${a} gold coins.`, `It finds ${b} more.`, 'How many coins now?'] },
    { op: '+', emoji: '🍯', lines: (a, b) => [`A potion needs ${a} drops of dew`, `and ${b} drops of honey.`, 'How many drops in all?'] },
    { op: '-', emoji: '🐸', lines: (a, b) => [`A witch has ${a} frogs.`, `${b} frogs hop away.`, 'How many frogs are left?'] },
    { op: '-', emoji: '🍪', lines: (a, b) => [`There are ${a} cookies on a plate.`, `The cat eats ${b} of them.`, 'How many cookies are left?'] },
    { op: '-', emoji: '⭐', lines: (a, b) => [`${a} stars twinkle in the sky.`, `Clouds hide ${b} of them.`, 'How many stars are left?'] },
    { op: '-', emoji: '🧪', lines: (a, b) => [`A shelf holds ${a} potion bottles.`, `The witch uses ${b} of them.`, 'How many bottles are left?'] },
    { op: '-', emoji: '🐞', lines: (a, b) => [`${a} ladybugs sit on a leaf.`, `${b} of them fly away.`, 'How many ladybugs are left?'] },
    { op: '-', emoji: '🎈', lines: (a, b) => [`The owl has ${a} balloons.`, `${b} balloons pop.`, 'How many balloons are left?'] },
  ];

  const STEP_NAMES = { 2: 'twos', 5: 'fives', 10: 'tens' };
  const tensAndOnes = (n) => `${plural(Math.floor(n / 10), 'ten')} and ${plural(n % 10, 'one')}`;

  // ------------------------------------------------------------------
  // Recipes: turn chosen numbers into a problem the game can show.
  //   title     – short instruction above the picture
  //   show      – what to draw (equation, blocks, number, sequence, story, clock, coins)
  //   say       – read aloud when the problem appears
  //   answer    – the digits to tap
  //   format    – 'number' (up to three digits) or 'time' (h:mm boxes)
  //   unit      – shown after the answer boxes, e.g. ¢
  //   solved    – [before, answer, after]: the finished sum for the result card
  //   sayAnswer – read aloud when the potion fizzles
  //   label     – short text for the end-of-round list
  //   key       – two problems with the same key are the same problem
  //   fact      – only on addition facts within 20 (see addFact), else null
  // ------------------------------------------------------------------
  function recipe(topic, key, fields) {
    const problem = { topic, key: `${topic}:${key}`, format: 'number', unit: '', fact: null, ...fields };
    if (!problem.label) problem.label = problem.solved.join('');
    return problem;
  }

  // An addition fact within 20 can be helped along with dots and a hint, and the
  // game remembers how quickly it is answered:
  //   key  – its name in the fact memory: "8+5", or "7+?=10" for a make-10 pair
  //   a, b – the two numbers that are added
  //   hint – the strategy the hint shows: 'count' (count on from the bigger number),
  //          'ten' (hop up to 10), 'bridge' (make 10 first) or 'near' (a double and 1 more)
  //   pair – true when each number gets a ten-frame of its own (doubles)
  const FACT_MAX = 20;
  const addFact = (a, b, hint = 'count', pair = false) => (
    a >= 1 && b >= 1 && a + b <= FACT_MAX ? { key: `${a}+${b}`, a, b, hint, pair } : null
  );

  const build = {
    add(a, b) {
      return recipe('add', `${a}+${b}`, {
        title: 'Add them up',
        show: { type: 'equation', parts: [String(a), '+', String(b), '=', '?'] },
        say: `What is ${a} plus ${b}?`,
        answer: String(a + b),
        solved: [`${a} + ${b} = `, String(a + b), ''],
        sayAnswer: `${a} plus ${b} is ${a + b}.`,
        fact: addFact(a, b),
      });
    },

    // Make 10: "7 + ? = 10"
    makeTen(n) {
      const rest = 10 - n;
      return recipe('make10', `ten:${n}`, {
        title: 'Make 10',
        show: { type: 'equation', parts: [String(n), '+', '?', '=', '10'] },
        say: `What goes with ${n} to make 10?`,
        answer: String(rest),
        solved: [`${n} + `, String(rest), ' = 10'],
        sayAnswer: `${n} and ${rest} make 10.`,
        fact: { key: `${n}+?=10`, a: n, b: rest, hint: 'ten', pair: false },
      });
    },

    // Bridge through 10: 8 + 5 is 8 + 2 + 3
    bridge(a, b) {
      const fill = 10 - a;
      return recipe('make10', `bridge:${a}+${b}`, {
        title: 'Make 10 first',
        show: { type: 'equation', parts: [String(a), '+', String(b), '=', '?'] },
        say: `What is ${a} plus ${b}? Make 10 first.`,
        answer: String(a + b),
        solved: [`${a} + ${b} = ${a} + ${fill} + ${b - fill} = `, String(a + b), ''],
        sayAnswer: `${a} plus ${b} is ${a + b}.`,
        label: `${a} + ${b} = ${a + b}`,
        fact: addFact(a, b, 'bridge'),
      });
    },

    double(n) {
      return recipe('doubles', `double:${n}`, {
        title: 'Doubles',
        show: { type: 'equation', parts: [String(n), '+', String(n), '=', '?'] },
        say: `Double ${n}. What is ${n} plus ${n}?`,
        answer: String(2 * n),
        solved: [`${n} + ${n} = `, String(2 * n), ''],
        sayAnswer: `${n} plus ${n} is ${2 * n}.`,
        fact: addFact(n, n, 'count', true),
      });
    },

    // Near doubles: 6 + 7 is 6 + 6 + 1
    nearDouble(a, b) {
      const small = Math.min(a, b);
      return recipe('doubles', `near:${a}+${b}`, {
        title: 'Double and 1 more',
        show: { type: 'equation', parts: [String(a), '+', String(b), '=', '?'] },
        say: `What is ${a} plus ${b}?`,
        answer: String(a + b),
        solved: [`${a} + ${b} = ${small} + ${small} + 1 = `, String(a + b), ''],
        sayAnswer: `${a} plus ${b} is ${a + b}.`,
        label: `${a} + ${b} = ${a + b}`,
        fact: addFact(a, b, 'near', true),
      });
    },

    sub(a, b) {
      return recipe('sub', `${a}-${b}`, {
        title: 'Take away',
        show: { type: 'equation', parts: [String(a), '−', String(b), '=', '?'] },
        say: `What is ${a} minus ${b}?`,
        answer: String(a - b),
        solved: [`${a} − ${b} = `, String(a - b), ''],
        sayAnswer: `${a} minus ${b} is ${a - b}.`,
      });
    },

    // Subtracting tens only: 80 − 60. The basic fact is 8 − 6 = 2, and the answer is 2 tens.
    tens(a, b) {
      const tensA = a / 10;
      const tensB = b / 10;
      const fact = tensA - tensB;
      const answer = a - b;
      return recipe('tens', `${a}-${b}`, {
        title: 'Subtract the tens',
        show: { type: 'tens', parts: [String(a), '−', String(b), '=', '?'], tens: tensA, take: tensB, fact },
        say: `What is ${a} minus ${b}? ${tenPhrase(tensA)} minus ${tenPhrase(tensB)}.`,
        answer: String(answer),
        solved: [`${a} − ${b} = ${tenPhrase(tensA)} − ${tenPhrase(tensB)} = `, String(answer), ''],
        sayAnswer: `${a} minus ${b} is ${answer}. ${tenPhrase(tensA)} minus ${tenPhrase(tensB)} is ${tenPhrase(fact)}.`,
        label: `${a} − ${b} = ${answer}`,
        retries: 1,
        practice: { kind: 'tens', a, b, tensA, tensB, fact },
      });
    },

    // Two-digit subtraction that needs a trade: the ones on top are smaller (52 − 27).
    borrow(top, bottom) {
      const T = Math.floor(top / 10);
      const O = top % 10;
      const B = Math.floor(bottom / 10);
      const C = bottom % 10;
      if (O >= C || top <= bottom || T < 2 || B < 1) return build.borrow(52, 27);
      const ones = O + 10 - C;
      const tens = T - 1 - B;
      const answer = top - bottom;
      return recipe('borrow', `${top}-${bottom}`, {
        title: 'Trade a ten',
        show: { type: 'borrow', top, bottom, tens: T, ones: O, subTens: B, subOnes: C },
        say: `What is ${top} minus ${bottom}? The ones need a ten.`,
        answer: String(answer),
        solved: [`${top} − ${bottom} = `, String(answer), ''],
        sayAnswer: `${top} minus ${bottom} is ${answer}.`,
        label: `${top} − ${bottom} = ${answer}`,
        retries: 2,
        practice: { kind: 'borrow', top, bottom, T, O, B, C, ones, tens },
      });
    },

    // Place value: count ten-rods and ones-cubes.
    blocks(n) {
      return recipe('place', `blocks:${n}`, {
        title: 'What number is this?',
        show: { type: 'blocks', tens: Math.floor(n / 10), ones: n % 10 },
        say: 'Count the tens and the ones. What number do the blocks make?',
        answer: String(n),
        solved: [`${tensAndOnes(n)} make `, String(n), ''],
        sayAnswer: `${tensAndOnes(n)} make ${n}.`,
      });
    },

    // Place value: "4 tens and 7 ones = ?"
    compose(n) {
      const tens = Math.floor(n / 10);
      return recipe('place', `compose:${n}`, {
        title: 'What number is this?',
        show: { type: 'equation', wordy: true, parts: [plural(tens, 'ten'), 'and', plural(n % 10, 'one'), '=', '?'] },
        say: `${tensAndOnes(n)}. What number is that?`,
        answer: String(n),
        solved: [`${tensAndOnes(n)} make `, String(n), ''],
        sayAnswer: `${tensAndOnes(n)} make ${n}.`,
      });
    },

    // Place value: "How many tens are in 47?" (`place` is 'tens' or 'ones')
    digit(n, place) {
      const count = place === 'tens' ? Math.floor(n / 10) : n % 10;
      const counted = plural(count, place === 'tens' ? 'ten' : 'one');
      return recipe('place', `${place}:${n}`, {
        title: `How many ${place} are in ${n}?`,
        show: { type: 'number', value: n },
        say: `How many ${place} are in ${n}?`,
        answer: String(count),
        solved: [`${n} has `, counted, ''],
        sayAnswer: `${n} has ${counted}.`,
      });
    },

    // Skip counting: `count` numbers in a row (five unless told otherwise), one of them missing.
    skip(start, step, blank, count = 5) {
      const all = Array.from({ length: count }, (_, i) => start + i * step);
      const items = all.map((n, i) => (i === blank ? null : n));
      return recipe('skip', `${start}:${step}:${blank}:${count}`, {
        title: `Count by ${step}s`,
        show: { type: 'sequence', items },
        say: `Count by ${STEP_NAMES[step]}. ${items.map((n) => (n === null ? 'blank' : n)).join(', ')}. What number is missing?`,
        answer: String(all[blank]),
        solved: [
          all.slice(0, blank).map((n) => `${n}, `).join(''),
          String(all[blank]),
          all.slice(blank + 1).map((n) => `, ${n}`).join(''),
        ],
        sayAnswer: `Counting by ${STEP_NAMES[step]}: ${all.join(', ')}.`,
      });
    },

    story(index, a, b) {
      const tale = stories[index];
      const plus = tale.op === '+';
      const result = plus ? a + b : a - b;
      const lines = tale.lines(a, b);
      return recipe('story', `${index}:${a}:${b}`, {
        title: 'Story potion',
        show: { type: 'story', emoji: tale.emoji, lines },
        say: lines.join(' '),
        answer: String(result),
        solved: [`${a} ${plus ? '+' : '−'} ${b} = `, String(result), ''],
        sayAnswer: `${a} ${plus ? 'plus' : 'minus'} ${b} is ${result}.`,
      });
    },

    // Telling time: `minute` is 0 (on the hour) or 30 (half past).
    time(hour, minute) {
      const mm = minute ? '30' : '00';
      return recipe('time', `${hour}:${mm}`, {
        title: 'What time is it?',
        show: { type: 'clock', hour, minute },
        say: 'Look at the clock. What time is it?',
        answer: `${hour}${mm}`,
        format: 'time',
        solved: ['', `${hour}:${mm}`, ''],
        sayAnswer: minute ? `It is ${hour} thirty. That is half past ${hour}.` : `It is ${hour} o'clock.`,
      });
    },

    // Coins: a list of cents, e.g. [10, 5, 1, 1].
    coins(list) {
      const cents = list.slice().sort((a, b) => b - a);
      const sum = total(cents);
      return recipe('coins', cents.join('+'), {
        title: 'How many cents?',
        show: { type: 'coins', cents },
        say: 'Count the coins. How many cents are there?',
        answer: String(sum),
        unit: '¢',
        solved: [`${cents.map((c) => `${c}¢`).join(' + ')} = `, `${sum}¢`, ''],
        sayAnswer: `The coins make ${sum} cents.`,
        label: `${sum}¢`,
      });
    },
  };

  // ------------------------------------------------------------------
  // Choosing the numbers for each topic and level
  // ------------------------------------------------------------------
  // Within 100, from gentle to tricky. Each one makes [a, b].
  const ADD_SHAPES = [
    () => [10 * randInt(1, 8), 10 * randInt(1, 8)],  // 30 + 40
    () => [randInt(11, 89), randInt(2, 9)],          // 46 + 7
    () => [randInt(11, 79), 10 * randInt(1, 8)],     // 34 + 20
    () => [randInt(11, 88), randInt(11, 88)],        // 27 + 15
    () => [randInt(11, 88), randInt(11, 88)],
  ];
  const SUB_SHAPES = [
    () => [10 * randInt(2, 10), 10 * randInt(1, 9)], // 80 − 30
    () => [randInt(11, 99), randInt(2, 9)],          // 43 − 6
    () => [randInt(21, 99), 10 * randInt(1, 8)],     // 67 − 20
    () => [randInt(21, 99), randInt(11, 88)],        // 52 − 27
    () => [randInt(21, 99), randInt(11, 88)],
  ];

  const choose = {
    add(level) {
      if (level === 'easy') {
        const a = randInt(2, 12);
        return build.add(a, randInt(1, Math.min(9, 20 - a)));
      }
      const [a, b] = roll(() => pick(ADD_SHAPES)(), ([x, y]) => x + y <= 100, [34, 20]);
      return build.add(a, b);
    },

    sub(level) {
      if (level === 'easy') {
        const a = randInt(3, 20);
        return build.sub(a, randInt(1, a - 1));
      }
      const [a, b] = roll(() => pick(SUB_SHAPES)(), ([x, y]) => x - y >= 1, [67, 20]);
      return build.sub(a, b);
    },

    place(level) {
      const n = level === 'easy' ? randInt(10, 20) : randInt(10, 99);
      const form = pick(['blocks', 'blocks', 'compose', 'tens', 'ones']);
      if (form === 'blocks') return build.blocks(n);
      if (form === 'compose') return build.compose(n);
      return build.digit(n, form);
    },

    skip(level) {
      // Easy: ask what comes next, and never count past 20. That makes the rows
      // short (5, 10, 15, ?) and leaves only 0, 10, ? for the tens, so tens are rarer.
      if (level === 'easy') {
        const small = pick([2, 2, 2, 5, 5, 10]);
        const count = randInt(3, Math.min(5, 20 / small + 1));
        const first = small * randInt(0, 20 / small - (count - 1));
        return build.skip(first, small, count - 1, count);
      }
      const step = pick([2, 5, 10]);
      let start = step * randInt(1, (100 - 4 * step) / step);
      if (step === 10 && Math.random() < 0.4) start = randInt(1, 59); // 13, 23, 33 ...
      return build.skip(start, step, randInt(2, 4));
    },

    story(level) {
      const index = randInt(0, stories.length - 1);
      const plus = stories[index].op === '+';
      let a;
      let b;
      if (level === 'easy') {
        a = plus ? randInt(2, 12) : randInt(5, 20);
        b = plus ? randInt(2, Math.min(9, 20 - a)) : randInt(2, a - 1);
      } else {
        a = plus ? randInt(11, 60) : randInt(21, 99);
        b = randInt(2, 30);
        if (!plus) b = Math.min(b, a - 1);
      }
      return build.story(index, a, b);
    },

    time(level) {
      return build.time(randInt(1, 12), level === 'easy' ? 0 : pick([0, 30, 30]));
    },

    coins(level) {
      const easy = level === 'easy';
      const purse = easy ? [1, 1, 5, 5, 10] : [1, 1, 5, 5, 10, 10, 25];
      const list = roll(
        () => Array.from({ length: randInt(easy ? 2 : 3, easy ? 5 : 6) }, () => pick(purse)),
        (coins) => total(coins) <= (easy ? 20 : 100) && new Set(coins).size > 1 && coins.filter((c) => c === 1).length <= 4,
        easy ? [10, 5, 1] : [25, 10, 5, 1],
      );
      return build.coins(list);
    },
  };

  function makeProblem(topic, level) {
    return (choose[topic] || choose.add)(levels.includes(level) ? level : 'hundred');
  }

  // Every fact of a drill, as ready problems. A round asks `core` facts first,
  // then `stretch` facts that build on them:
  //   make10   what goes with 7 to make 10?  then  8 + 5 by way of 10 (bigger number first)
  //   doubles  6 + 6                         then  6 + 7 and 7 + 6
  // Every subtracting-tens problem (answers 0–90) or every borrowing problem.
  // Borrowing problems are two-digit, need a trade, and stay between 1 and 99.
  let tensCache = null;
  let borrowCache = null;
  function practiceProblems(kind) {
    if (kind === 'borrow') {
      if (!borrowCache) {
        borrowCache = [];
        for (let T = 2; T <= 9; T++) {
          for (let B = 1; B < T; B++) {
            for (let C = 1; C <= 9; C++) {
              for (let O = 0; O < C; O++) borrowCache.push(build.borrow(T * 10 + O, B * 10 + C));
            }
          }
        }
      }
      return borrowCache;
    }
    if (!tensCache) {
      tensCache = [];
      for (let a = 10; a <= 90; a += 10) {
        for (let b = 0; b <= a; b += 10) tensCache.push(build.tens(a, b));
      }
    }
    return tensCache;
  }

  // One round of a single kind. Problems she has missed come first (more often),
  // then new ones. The two kinds are never put in the same list.
  function practiceRound(kind, missed, count = 8) {
    const all = practiceProblems(kind === 'borrow' ? 'borrow' : 'tens');
    const weight = missed && typeof missed === 'object' ? missed : {};
    const due = all
      .filter((problem) => weight[problem.key] > 0)
      .sort((a, b) => weight[b.key] - weight[a.key] || (a.key < b.key ? -1 : 1));
    const reviewCount = Math.min(due.length, Math.max(0, count - 2));
    const chosen = due.slice(0, reviewCount);
    const seen = new Set(chosen.map((problem) => problem.key));
    const rest = all.filter((problem) => !seen.has(problem.key));
    const fresh = shuffle(rest.filter((problem) => !weight[problem.key]))
      .concat(shuffle(rest.filter((problem) => weight[problem.key])));
    for (const problem of fresh) {
      if (chosen.length >= count) break;
      chosen.push(problem);
    }
    return chosen.slice(0, count);
  }

  // A gentle hint for a wrong answer. It names what she did and lets her try again.
  // The last step of a borrowing hint (attempt 1) says the answer; the first one shows the way.
  function practiceHint(problem, guess, attempt = 0) {
    const p = problem && problem.practice;
    if (!p) return { close: false, title: 'Let’s look again', text: 'Have another try.', note: 'Have another try.' };
    return p.kind === 'tens' ? tensHint(p, Number(guess)) : borrowHint(p, Number(guess), attempt);
  }

  function tensHint(p, guess) {
    const answer = p.a - p.b;
    const line = `${tenPhrase(p.tensA)} minus ${tenPhrase(p.tensB)} is ${tenPhrase(p.fact)}, which is ${answer}.`;
    if (guess === p.fact && p.fact !== answer) {
      const text = `Close! These are tens. ${line}`;
      return { close: true, title: 'Close!', text, note: text };
    }
    const text = `Count the rods that are left. ${line}`;
    return { close: false, title: 'Count the tens', text, note: text };
  }

  function borrowHint(p, guess, attempt) {
    const answer = p.top - p.bottom;
    const flipped = (p.C - p.O) + (p.T - p.B) * 10; // smaller digit minus bigger digit, in each column
    const forgot = p.ones + (p.T - p.B) * 10; // ones traded, but the ten was not taken off the tens
    const tensOnly = p.tens * 10;
    const full = `Trade a ten. ${p.O + 10} minus ${p.C} is ${p.ones}. ${p.T - 1} minus ${p.B} is ${p.tens}. The answer is ${answer}.`;
    const note = `${p.O + 10} − ${p.C} = ${p.ones}, then ${p.T - 1} − ${p.B} = ${p.tens}. That makes ${answer}.`;
    if (attempt >= 1) return { close: false, title: 'Let’s put it together', text: full, note };
    if (guess === flipped) {
      const text = `Close! ${p.O} is smaller than ${p.C}, so we don’t take the little number from the big one. Trade a ten. Now you have ${p.O + 10} ones. ${p.O + 10} − ${p.C} = ${p.ones}.`;
      return { close: true, title: 'Trade a ten', text, note: `Trade a ten: ${p.O + 10} − ${p.C} = ${p.ones}. Then the tens.` };
    }
    if (guess === forgot) {
      const text = `The ones are right: ${p.ones}. You traded a ten, so the tens are ${p.T - 1} − ${p.B}, not ${p.T} − ${p.B}.`;
      return { close: true, title: 'Check the tens', text, note: text };
    }
    if (guess === p.ones) {
      const text = `That’s the ones: ${p.ones}. Now the tens. ${p.T - 1} − ${p.B} = ${p.tens}.`;
      return { close: true, title: 'That’s the ones', text, note: text };
    }
    if (guess === tensOnly || guess === p.tens) {
      const text = `That’s the tens: ${tenPhrase(p.tens)} is ${tensOnly}. The ones are ${p.ones} more.`;
      return { close: true, title: 'That’s the tens', text, note: `${tenPhrase(p.tens)} and ${p.ones} ones make ${answer}.` };
    }
    if (guess === p.T - p.B) {
      const text = `Trade a ten first. ${p.T} tens becomes ${p.T - 1}, and the ones become ${p.O + 10}.`;
      return { close: false, title: 'Trade a ten', text, note: text };
    }
    const text = `Look at the ones. ${p.O} is smaller than ${p.C}, so trade a ten. ${p.O + 10} − ${p.C} = ${p.ones}. Then the tens: ${p.T - 1} − ${p.B} = ${p.tens}.`;
    return { close: false, title: 'Trade a ten', text, note: `${p.O + 10} − ${p.C} = ${p.ones}. Then ${p.T - 1} − ${p.B} = ${p.tens}.` };
  }

  // Which subtracting problems to ask again. A new key, never mixed into the old save.
  //   missed – problem key -> how many times that try was missed (higher comes first)
  function cleanSubtract(raw) {
    const missed = {};
    const bag = raw && typeof raw === 'object' ? raw.missed : null;
    if (bag && typeof bag === 'object') {
      for (const [key, count] of Object.entries(bag)) {
        if (!/^(tens|borrow):\d+-\d+$/.test(key)) continue;
        const n = Math.floor(Number(count));
        if (n > 0 && n < 100) missed[key] = n;
      }
    }
    trimMissed(missed);
    return { missed };
  }

  function trimMissed(missed) {
    const keys = Object.keys(missed);
    if (keys.length <= 40) return;
    keys.sort((a, b) => missed[a] - missed[b] || (a < b ? -1 : 1));
    for (const key of keys.slice(0, keys.length - 40)) delete missed[key];
  }

  // The first stumble: remember it so the next round starts here, without piling on.
  function touchMiss(store, key) {
    if (!store.missed[key]) store.missed[key] = 1;
    trimMissed(store.missed);
  }

  // The try fizzled: it should come back even sooner than the others.
  function noteMiss(store, key) {
    store.missed[key] = (store.missed[key] || 0) + 1;
    trimMissed(store.missed);
  }

  // She solved it on the first try this time, so it can rest.
  function forgetMiss(store, key) {
    delete store.missed[key];
  }

  function drillFacts(id) {
    if (id === 'doubles') {
      return {
        core: range(1, 10).map((n) => build.double(n)),
        stretch: range(2, 9).flatMap((n) => [build.nearDouble(n, n + 1), build.nearDouble(n + 1, n)]),
      };
    }
    return {
      core: range(1, 9).map((n) => build.makeTen(n)),
      stretch: range(6, 9).flatMap((a) => range(11 - a, a - 1).map((b) => build.bridge(a, b))),
    };
  }

  // A round of `count` different problems, spread evenly over the topics that are switched on.
  // `review` lists addition facts as [a, b] that are due for another go: they take
  // the place of fresh sums, so slow and missed facts come back more often.
  function makeRound(settings, count, review = []) {
    let on = topics.map((topic) => topic.id).filter((id) => settings.topics && settings.topics[id]);
    if (!on.length) on = ['add'];
    let order = [];
    while (order.length < count) order = order.concat(shuffle(on));
    const waiting = review.slice();
    const seen = new Set();
    return shuffle(order.slice(0, count)).map((topic) => {
      let problem = topic === 'add' && waiting.length ? build.add(...waiting.shift()) : makeProblem(topic, settings.level);
      for (let tries = 0; tries < 30 && seen.has(problem.key); tries++) problem = makeProblem(topic, settings.level);
      seen.add(problem.key);
      return problem;
    });
  }

  // ------------------------------------------------------------------
  // What a finished potion does. Scenes are built just like the spell results
  // in words.js (main, hat, ride, orbit, rain, move).
  // ------------------------------------------------------------------
  const brews = [
    { say: 'Your potion made a hippo in a flower crown!', main: '🦛', hat: '🌼', move: 'wobble' },
    { say: 'Your potion made a cow floating with balloons!', main: '🐮', orbit: '🎈', move: 'float' },
    { say: 'Your potion made it rain lollipops!', main: '🍭', rain: '🍭', move: 'bounce' },
    { say: 'Your potion made a flamingo on ice skates!', main: '🦩', ride: '⛸️', move: 'zoom' },
    { say: 'Your potion made a hedgehog with a sparkly crown!', main: '🦔', hat: '👑', move: 'bounce' },
    { say: 'Your potion made a bunny bouncing on a drum!', main: '🐰', ride: '🥁', move: 'bounce' },
    { say: 'Your potion made a giggling crocodile dance!', main: '🐊', move: 'dance' },
    { say: 'Your potion made a sheep juggling rainbows!', main: '🐑', orbit: '🌈', move: 'wobble' },
    { say: 'Your potion made a lobster in a party bow!', main: '🦞', hat: '🎀', move: 'dance' },
    { say: 'Your potion made an elephant sitting on a teacup!', main: '🐘', ride: '☕', move: 'wobble' },
    { say: 'Your potion made a dancing cactus!', main: '🌵', move: 'dance' },
    { say: 'Your potion made a parrot in a pancake hat!', main: '🦜', hat: '🥞', move: 'wobble' },
    { say: 'Your potion made a sloth zooming on a scooter!', main: '🦥', ride: '🛴', move: 'zoom' },
    { say: 'Your potion made it rain donuts!', main: '🍩', rain: '🍩', move: 'wobble' },
    { say: 'Your potion made a raccoon riding a bicycle!', main: '🦝', ride: '🚲', move: 'zoom' },
    { say: 'Your potion made a baby dragon hugging hearts!', main: '🐲', orbit: '💖', move: 'float' },
    { say: 'Your potion made a squirrel juggling acorns!', main: '🐿️', orbit: '🌰', move: 'bounce' },
    { say: 'Your potion made a giant wobbly pudding!', main: '🍮', move: 'wobble' },
    { say: 'Your potion made a tap-dancing crab!', main: '🦀', move: 'dance' },
    { say: 'Your potion made a lion in a strawberry hat!', main: '🦁', hat: '🍓', move: 'bounce' },
    { say: 'Your potion made a giraffe in a tiny top hat!', main: '🦒', hat: '🎩', move: 'float' },
    { say: 'Your potion made a snowman surfing on a watermelon!', main: '⛄', ride: '🍉', move: 'zoom' },
  ];

  const cheers = ['Fizz, pop!', 'Bubble, bubble!', 'Whoosh!', 'Bloop!', 'Swirl, twirl!', 'Ta-da!', 'Sparkle, fizz!'];

  // Gentle words for a potion that did not work. Never scolding.
  const fizzles = [
    'Every witch spills a potion sometimes.',
    'Even the best brews take a few tries.',
    'So close! Potions take practice.',
    'Your cauldron is still warming up.',
  ];

  return {
    levels, topics, drills, practices, stories, build, makeProblem, makeRound, drillFacts,
    practiceProblems, practiceRound, practiceHint, cleanSubtract, touchMiss, noteMiss, forgetMiss,
    brews, cheers, fizzles,
  };
})();
