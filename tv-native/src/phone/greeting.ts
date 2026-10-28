// Home's greeting on the phone — the website's words (public/js/screens/
// home.js "The greeting"): the part of the day with the name, and a line
// under it that changes by the day (Friday night and the weekend have their
// own). Pure, so it is tested.
const DAILY = [
  "What's on the plate tonight — a movie, or a show?",
  "The watchlist isn't going to watch itself.",
  'Pick something good. No pressure.',
  'One episode. Sure. “One.”',
  'The couch is preheated.',
];

export function greeting(name: string, now: Date = new Date()): {line: string; sub: string} {
  const h = now.getHours();
  const day = now.getDay();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const line = part === 'Up late' ? `Up late, ${name}?` : `${part}, ${name}`;
  const daily = DAILY[(now.getFullYear() * 366 + now.getMonth() * 31 + now.getDate()) % DAILY.length];
  const sub =
    day === 5 && h >= 17
      ? 'Friday. Movie night is legally required.'
      : day === 6 && h >= 11
      ? 'Weekend. A double feature is fully justified.'
      : daily;
  return {line, sub};
}
