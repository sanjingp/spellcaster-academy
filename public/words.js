// Spellcaster Academy — words, wardrobe and silly spell results.
// Plain data only; game.js does all the work.
window.SPELLCASTER_DATA = {
  // ~12 common 2nd-grade spelling words (no homophones, so "spell it from sound" is fair).
  starterWords: [
    'again', 'always', 'because', 'before', 'could', 'every',
    'family', 'friend', 'little', 'people', 'pretty', 'school',
  ],

  // Robe colors. `cost` is the total stars needed to unlock.
  robes: [
    { id: 'twilight', name: 'Twilight Purple', cost: 0, main: '#8f5cf0', dark: '#6a3fd0', trim: '#ffd75e' },
    { id: 'bubblegum', name: 'Bubblegum Pink', cost: 6, main: '#ff6fb5', dark: '#e0468f', trim: '#fff1a8' },
    { id: 'mermaid', name: 'Mermaid Teal', cost: 15, main: '#2ec4b6', dark: '#1a9c97', trim: '#ffe98a' },
    { id: 'sunshine', name: 'Sunshine Gold', cost: 27, main: '#ffc233', dark: '#f09a1a', trim: '#ffffff' },
    { id: 'midnight', name: 'Midnight Blue', cost: 42, main: '#3f51d9', dark: '#2a37a8', trim: '#ffd75e' },
    {
      id: 'rainbow', name: 'Rainbow Magic', cost: 60, main: '#ff7ac3', dark: '#7b5cf0', trim: '#ffffff',
      rainbow: ['#ff6b8b', '#ffb347', '#ffe66d', '#6fdc8c', '#5bc0f8', '#a78bfa'],
    },
  ],

  // Familiars (magical pets). Emoji only.
  familiars: [
    { id: 'cat', name: 'Pumpkin the cat', emoji: '🐱', cost: 0 },
    { id: 'owl', name: 'Hoot the owl', emoji: '🦉', cost: 9 },
    { id: 'bunny', name: 'Clover the bunny', emoji: '🐰', cost: 20 },
    { id: 'fox', name: 'Ember the fox', emoji: '🦊', cost: 33 },
    { id: 'dragon', name: 'Sparky the dragon', emoji: '🐲', cost: 50 },
    { id: 'unicorn', name: 'Stardust the unicorn', emoji: '🦄', cost: 70 },
  ],

  // What a successful spell conjures. A scene is built from emoji:
  //   main  – the star of the show          hat   – sits on top of main
  //   ride  – sits underneath main           orbit – circles around main
  //   rain  – falls from the sky             move  – bounce | wobble | float | zoom | spin
  outcomes: [
    { say: 'You made a frog in a cupcake hat!', main: '🐸', hat: '🧁', move: 'bounce' },
    { say: 'You made a cat in a fancy top hat!', main: '🐱', hat: '🎩', move: 'wobble' },
    { say: 'You made a penguin on a skateboard!', main: '🐧', ride: '🛹', move: 'zoom' },
    { say: 'You made an octopus juggling donuts!', main: '🐙', orbit: '🍩', move: 'wobble' },
    { say: 'You made a duck wearing a crown!', main: '🦆', hat: '👑', move: 'bounce' },
    { say: 'You made a piglet floating on a cloud!', main: '🐷', ride: '☁️', move: 'float' },
    { say: 'You made a turtle riding a rocket!', main: '🐢', ride: '🚀', move: 'zoom' },
    { say: 'You made a giant dancing strawberry!', main: '🍓', move: 'dance' },
    { say: 'You made it rain popcorn!', main: '🍿', rain: '🍿', move: 'bounce' },
    { say: 'You made a puppy with a pizza hat!', main: '🐶', hat: '🍕', move: 'wobble' },
    { say: 'You made a hamster with party balloons!', main: '🐹', orbit: '🎈', move: 'float' },
    { say: 'You made a dinosaur in ballet shoes!', main: '🦖', ride: '🩰', move: 'dance' },
    { say: 'You made a snail in a race car!', main: '🐌', ride: '🏎️', move: 'zoom' },
    { say: 'You made a bear juggling honey pots!', main: '🐻', orbit: '🍯', move: 'wobble' },
    { say: 'You made a chick in a birthday cake hat!', main: '🐥', hat: '🎂', move: 'bounce' },
    { say: 'You made a unicorn juggling cupcakes!', main: '🦄', orbit: '🧁', move: 'bounce' },
    { say: 'You made a mouse surfing on cheese!', main: '🐭', ride: '🧀', move: 'zoom' },
    { say: 'You made a whale in a graduation cap!', main: '🐳', hat: '🎓', move: 'float' },
    { say: 'You made a pickle doing the wiggle dance!', main: '🥒', move: 'dance' },
    { say: 'You made a bee with a flower hat!', main: '🐝', hat: '🌸', move: 'float' },
    { say: 'You made an elephant holding a balloon!', main: '🐘', hat: '🎈', move: 'float' },
    { say: 'You made it rain silly socks!', main: '🧦', rain: '🧦', move: 'wobble' },
    { say: 'You made a banana in a top hat!', main: '🍌', hat: '🎩', move: 'dance' },
    { say: 'You made a llama in a baseball cap!', main: '🦙', hat: '🧢', move: 'wobble' },
    { say: 'You made a monkey juggling bananas!', main: '🐵', orbit: '🍌', move: 'bounce' },
    { say: 'You made a koala riding a rainbow!', main: '🐨', ride: '🌈', move: 'float' },
  ],

  cheers: ['Poof!', 'Zap!', 'Ta-da!', 'Abracadabra!', 'Shazam!', 'Alakazam!', 'Hocus pocus!'],

  // Gentle words for a spell that did not work. Never scolding.
  fizzles: [
    'Every witch needs practice.',
    'Even the best spells take a few tries.',
    'So close! Magic takes practice.',
    'Your wand is still warming up.',
  ],
};
