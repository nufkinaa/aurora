// Wrapped's roast cards (GET /api/profiles/:id/wrapped → roasts). One kind
// per rule over the wrapped stats (src/lib/remarks/roasts.js); up to 140
// characters. Fields: {n} {m} {pct} {hour} {title} (40 at most) {date}
// {hours} {genre} {day} {name}.
"use strict";
module.exports = {
  "roast-commitment": {
    code: "rc",
    roast: true,
    lines: [
      "You've started {n} things and finished {m}. Commitment issues, but make it streaming.",
      "{n} started, {m} finished. The rest are still waiting by the door with their coats on.",
      "You finish about one in every few things you start. {n} beginnings, {m} endings. A collector of first acts.",
      "{n} titles started. {m} seen through. The others would like to know where they stand.",
      "Your ratio of starting to finishing is {n} to {m}. Somewhere, a screenwriter is weeping into an unseen third act.",
      "{n} openings, {m} endings. You treat stories like a box of chocolates: one bite each, the rest put back.",
      "Of {n} things you started, {m} got an ending. The others are frozen mid-scene, forever, because of you.",
      "{n} started, {m} finished. If films could leave reviews, yours would say \"walked out early\".",
    ],
  },
  "roast-zero-finished": {
    code: "rz",
    roast: true,
    lines: [
      "{n} titles started. Zero finished. Bold strategy.",
      "{n} beginnings, not one ending. You've seen more opening credits than anyone alive.",
      "You started {n} things and finished none of them. The endings exist. I've checked.",
      "{n} titles, zero finales. You're a trailer person living in a feature-length world.",
      "Not one of your {n} started titles has an ending yet. Spoiler: they all have one.",
      "{n} starts and no finishes. At this point the stopping is the hobby.",
    ],
  },
  "roast-late-finish": {
    code: "rl",
    roast: true,
    lines: [
      "You once finished \"{title}\" at {hour}am. The sunrise saw everything.",
      "\"{title}\" ended at {hour}am, and so did your dignity. I was there. I logged it.",
      "{hour}am, \"{title}\", credits rolling. The birds were up before you went to bed.",
      "You finished \"{title}\" at {hour} in the morning. Nobody needs to know. I already do.",
      "At {hour}am you were still watching \"{title}\". The night shift would be proud.",
      "You once watched something until {hour}am. On a normal night. With no excuse at all.",
      "Your latest finish was at {hour}am. Bedtime is a suggestion you've stopped hearing.",
      "At {hour}am you were finishing a film. The neighbours' lights were off. Yours were not.",
    ],
  },
  "roast-late-sessions": {
    code: "rn",
    roast: true,
    lines: [
      "{n} sessions started after midnight. You and 3am are basically in a long-term arrangement.",
      "{n} times you pressed play after midnight. Your pillow has filed a missing-person report.",
      "After midnight, {n} times. Most people use those hours for sleep. You use them for \"one more\".",
      "{n} late-night sessions. If owls had a streaming service, you'd be their best customer.",
      "You've started {n} things after midnight. The small hours know you by name.",
      "{n} sessions past midnight. Tomorrow-you has stopped speaking to tonight-you.",
    ],
  },
  "roast-big-day": {
    code: "rb",
    roast: true,
    lines: [
      "On {date} you watched {hours}. The sun called. You let it go to voicemail.",
      "{date}: {hours} of viewing. That's not a day off. That's a residency.",
      "On {date} you put in {hours}. A full working day, unpaid, on the couch.",
      "{hours} on {date}. The couch still has the impression. It may never recover.",
      "Your biggest day was {date}: {hours}. Somewhere, a to-do list from that day is still waiting.",
      "{date} was a {hours} day. I'd ask what happened, but I know exactly what happened.",
    ],
  },
  "roast-streak": {
    code: "rs",
    roast: true,
    lines: [
      "{n} days in a row. The couch has permanently taken your shape.",
      "A {n}-day streak. Gyms would kill for your consistency. Wrong venue, though.",
      "{n} consecutive days. At some point it stopped being a habit and became a lifestyle.",
      "{n} days without a break. Even the films took more days off than you.",
      "You watched something {n} days straight. The remote is considering unionising.",
      "{n} days in a row. I'd hand you a trophy, but you'd just put it on the couch.",
    ],
  },
  "roast-top-share": {
    code: "rt",
    roast: true,
    lines: [
      "\"{title}\" is {pct}% of everything you've watched. It's not a phase.",
      "{pct}% of your viewing is \"{title}\". The rest of the library has started a support group.",
      "\"{title}\" takes up {pct}% of your history. At this point it should be paying rent.",
      "You've given {pct}% of your time to \"{title}\". It's a relationship. A one-sided one.",
      "{pct}% \"{title}\". Everything else here is just set dressing to you.",
      "One title, {pct}% of your viewing. You're not a fan. You're a tenant.",
    ],
  },
  "roast-phone": {
    code: "rp",
    roast: true,
    lines: [
      "Mostly watched on your phone. There's a beautiful big screen right there, {name}. It misses you.",
      "You do most of your watching on a phone. The TV has started leaving passive-aggressive screensavers.",
      "{name}, your phone sees more films than the big screen. Somewhere a director feels a chill.",
      "Mostly phone viewing. You've seen epic battles at the size of a postage stamp. Tragic, really.",
      "Phone first, big screen never. The cinematographers send their thoughts and a magnifying glass.",
      "Your phone is your cinema, {name}. The TV is just furniture with ambitions now.",
    ],
  },
  "roast-variety": {
    code: "rv",
    roast: true,
    lines: [
      "{n} sessions across {m} titles. Variety is overrated anyway.",
      "{n} plays, {m} titles. You found what you like and you are not letting go.",
      "You pressed play {n} times and kept landing on the same {m} titles. Comfort, or a rut. I won't say which.",
      "{m} titles, {n} sessions. The rest of the library has stopped auditioning.",
      "{n} sessions, {m} titles. Most people explore. You revisit. Relentlessly.",
    ],
  },
  "roast-genre": {
    code: "rg",
    roast: true,
    lines: [
      "{pct}% of your viewing is {genre}. The other genres have stopped sending invitations.",
      "{genre}, {genre}, {genre}. {pct}% of your time. Have you considered literally anything else?",
      "{pct}% {genre}. It's not a taste anymore. It's a diet. A very narrow diet.",
      "You spend {pct}% of your time on {genre}. The comedies have stopped calling.",
      "{pct}% of everything you watch is {genre}. I'd suggest a change, but you'd ignore it, as usual.",
    ],
  },
  "roast-longest": {
    code: "ro",
    roast: true,
    lines: [
      "Your longest sitting: {hours} of \"{title}\". Not one stretch. Not one snack run. Admirable. Alarming.",
      "{hours} in one go on \"{title}\". You didn't watch it. You moved in.",
      "You once sat through {hours} of \"{title}\" without stopping. The couch still talks about it.",
      "Longest session: {hours}. You didn't stand up once. I'd have checked on you if I could.",
      "{hours} without a break. Most films ask for two. You gave {hours} and asked for more.",
    ],
  },
  "roast-weekday": {
    code: "rd",
    roast: true,
    lines: [
      "{day} is your big viewing day. Whatever happens on a {day}, you're not there for it.",
      "You watch the most on a {day}. Every week, like a standing appointment with the couch.",
      "{day}s belong to the couch. Everyone who knows you has stopped making {day} plans.",
      "Your heaviest day is {day}. You've turned it into a small weekly festival. Attendance: you.",
    ],
  },
  "roast-clean": {
    code: "rk",
    roast: true,
    lines: [
      "Honestly? Nothing to roast. Balanced viewing, reasonable hours. Who are you, {name}?",
      "Clean record. Sensible hours, finished stories. I'm almost disappointed, {name}.",
      "No bad habits found. Either you're a model viewer, {name}, or you watch somewhere else.",
      "Nothing to report. Moderate, tidy, punctual. You're no fun at all, {name}. I mean that warmly.",
      "I looked for something to tease you about, {name}. Nothing. Give me something next year.",
    ],
  },
  "roast-kids": {
    code: "ry",
    kids: true,
    roast: true,
    lines: [
      "{n} stories watched. That's a lot of adventures for one hero.",
      "You've been on {n} adventures here. The cartoons think you're the best audience.",
      "{n} shows and films. Your favourites must be very happy.",
      "Look at you: {n} stories so far. The heroes say thank you for watching.",
      "{n} adventures. Dragons, robots, rabbits. You've met them all.",
    ],
  },
};
