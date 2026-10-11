// Spellcaster Academy — potion recipes: 2nd-grade math problems and silly brew results.
// Plain data and pure functions only (nothing here touches the page); game.js does the brewing.
window.SPELLCASTER_POTIONS = (() => {
  'use strict';

  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const total = (list) => list.reduce((sum, n) => sum + n, 0);

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
  // ------------------------------------------------------------------
  function recipe(topic, key, fields) {
    const problem = { topic, key: `${topic}:${key}`, format: 'number', unit: '', ...fields };
    if (!problem.label) problem.label = problem.solved.join('');
    return problem;
  }

  const build = {
    add(a, b) {
      return recipe('add', `${a}+${b}`, {
        title: 'Add them up',
        show: { type: 'equation', parts: [String(a), '+', String(b), '=', '?'] },
        say: `What is ${a} plus ${b}?`,
        answer: String(a + b),
        solved: [`${a} + ${b} = `, String(a + b), ''],
        sayAnswer: `${a} plus ${b} is ${a + b}.`,
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

  // A round of `count` different problems, spread evenly over the topics that are switched on.
  function makeRound(settings, count) {
    let on = topics.map((topic) => topic.id).filter((id) => settings.topics && settings.topics[id]);
    if (!on.length) on = ['add'];
    let order = [];
    while (order.length < count) order = order.concat(shuffle(on));
    const seen = new Set();
    return shuffle(order.slice(0, count)).map((topic) => {
      let problem = makeProblem(topic, settings.level);
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

  return { levels, topics, stories, build, makeProblem, makeRound, brews, cheers, fizzles };
})();
