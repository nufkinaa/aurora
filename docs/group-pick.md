# What do we watch tonight? (group pick)

A few people in a room decide together. One of them starts a session — usually on the TV, which then shows a big code and a QR code — and everyone else joins on their own phone or browser by scanning the code or typing it. Everyone swipes **yes / maybe / no** through the same cards at the same time. Aurora finds the overlap and shows the pick on the big screen with a short why ("3 of 3 said yes"). One press plays it; "Something else" shows the next one.

Where it lives:

| Part | File |
|---|---|
| Sessions (join, leave, roles, timeouts) | `src/lib/grouppick.js` |
| The deck and the group score | `src/media/groupdeck.js` |
| Routes (behind the profile gate) | `src/routes/group.js` |
| Live "it changed" | `src/realtime.js` (`group_watch` / `group_update`) |
| Website | `public/js/screens/group.js` (`#/group`, `#/group/<code>`), words `public/js/groupwords.js` |
| TV | `tv-native/src/screens/GroupPick.tsx` (from the AI screen and Settings) |
| Phone app | `tv-native/src/phone/screens/GroupPick.tsx` (profile menu, and the QR link `…/#/group/<code>`) |
| Shared app words and rules | `tv-native/src/groupPick.ts` (= `groupwords.js` to the letter), `groupPickApi.ts` |

## Who can take part

Household only, and only as yourself. Every route acts as the profile in its address and goes through the same gate as that profile's own data: the profile must exist, in "closed" mode the session must own it, a profile with a password needs its unlock token, an admin-locked profile is refused. A code is four characters from an alphabet without look-alikes (no I, O, 0, 1). Someone who types many wrong codes (12 in 5 minutes) is asked to wait.

A **member** is a person on a device. A member is either a **voter** or a **screen**: the TV that starts a session is the screen (it shows the code, the progress and the pick) unless someone presses **Vote here with the remote** (the TV's lobby; with nobody in yet it is the key the focus starts on). A browser on a big screen can be the screen as well ("Swipe on this screen too").

**Every voting device is its own seat** (2026-11-22). The TV and a phone signed in to the same profile are two voters, shown as "Elia (TV)" and "Elia (phone)" — a household often shares one profile, and the person at the TV must be able to vote next to the one on the phone. Before, the ballot was the person's: the TV's answers and the phone's were one ballot, so once the phone had answered every card the TV had none left and could not vote at all. The cost: one person who votes on two of their own devices counts twice — the seat names make that visible, and "Only show the code and the result here" gives the TV's seat up. The deck is still built for the people (one taste per profile).

## The deck

Built when the host presses **Start swiping**, for the people who are in at that moment.

1. **Candidates**: the library (always), the recommender's title index (when it is in memory), what is new and popular now (the catalogue's cached trending list and the "new" shelves of Browse, `media/discover.js` — fetched in the background when a session opens, so they are there when the host deals; a film still only in cinemas is left out) and the catalogue's well-known titles (the "Swipe your taste" pool).
2. **Never again** (2026-11-22): every card a deck shows — the first deal, every other round, a title added during swiping — is remembered for everyone in the room, the voters and the room's screen (`data/group-dealt.json`, `lib/groupdealt.js`: which titles, for whom, when; nothing about answers). No later deck for any of them deals it again, by its library id or its IMDb id. When every title that fits the choices has been dealt before, the room is told so ("You've been dealt every title that fits these choices — try another mood, length or films / series") instead of being dealt old cards.
2. **The starter's choices**: films, series or both; a mood (each mood is a few genres, plus the taxonomy's themes when the index knows a title's themes — "Feel-good" is Family/Animation/Romance or the feel-good / light-fun / romcom / underdog themes, and never Horror or War); a length ("Under 2 h" is a film's runtime, or a series' episode length; an unknown runtime is let through).
3. **Kids**: if anyone in the room is a kids profile (or the starting device is in kids mode), the strictest age limit applies to the deck, to search and to adding. A title with no known age rating is out, as everywhere.
4. **Probably seen** (2026-11-22, elia: "introduce new content the user has probably not seen"): a title that **anyone in the room** — every voter and the room's screen — has probably seen is **out**, as long as the deck can be filled without it. "Probably seen" for a person is: anything they started or watched (Continue Watching, the watch history, an episode counts for its series, stream plays), finished films, rated, loved or "Not for me" titles, My List and followed titles, and the recommender's own "seen" set (`media/recs/person.js` collectEvents — the same set that keeps a title out of Home's recommendations). On top of that a **very famous** catalogue title (the top of the well-known list, `FAMOUS_POP`) is presumed seen and sinks, unless someone in the room said **"Haven't seen"** to it in Swipe your taste. Only when the unseen titles run short do seen-by-some titles fill the rest of the deck — always at the back, each card saying who has seen it ("Dana has seen it"), and the room is told in one line on the deck ("Running out of titles none of you has seen for these choices — the last cards are ones someone here has seen"). A title everyone has seen is never dealt.
5. **Fair fit**: each voter's own fit for every candidate comes from the recommender's person model (taste, nearest liked titles, dislikes). For someone the recommender does not know yet, it is the genres they said they like and the genres of the titles they loved. Each person's fits are turned into **percentiles** among the candidates, so a person with a long history (big raw scores) does not outvote someone with a short one. The group fit is `0.6 × average + 0.4 × lowest` — a title one person would hate does not get in on the others' love. A voter with no opinion on a title counts as the middle.
6. **On the server first**: a library title scores higher (it plays now, no download), and at least half the deck is the library while the library has enough that fits.
7. **New**: at least a quarter of the deck is from this year or last while the candidates have enough of them.
8. **Variety**: a genre already in the deck counts a little less each time, so twenty cards are not twenty thrillers; a random share of every score (0.2) changes which of the good titles come up on each deal. Then a light shuffle keeps the strongest few near the top.

Twenty cards. **Added titles**: anyone in the session can add a title with the search inside the session (up to 5 each per round). In the lobby they go into the deck early (every other card from the second); during swiping they go to the end of everyone's deck. **Adding a title counts as your yes.**

## The group score

Each answer has a value: **yes = 1, maybe = 0.6, no = 0, not answered = 0.45** (a shrug — someone who did not get to a card is not a no).

```
score = 0.55 × average + 0.45 × lowest   (+ 0.04 × the deck's group fit, as a tie-break)
```

- The **average** says "most of us want it".
- The **lowest** is the *least misery* rule: one "no" pulls a title down hard. It is not an absolute veto — when nothing else got through, a title two people loved can still be offered.
- A title needs **at least one yes** to be a pick.
- **Everyone said yes** comes first, whatever the score. Then the score; ties go to more yeses, fewer nos, the library, the group fit.

Examples with three people: yes/yes/yes is the pick. yes/maybe/maybe (0.67) beats yes/yes/no (0.37): two lukewarm people are fairer than one unhappy one. yes/yes/not-answered (0.65) also beats yes/yes/no.

**The why is counted, never named**: "3 of 3 said yes", "Both of you said yes", "2 of 3 said yes · 1 maybe", "2 of 3 said yes · 1 didn't get to it". Who said no is nobody's business at a sofa; during swiping nobody sees anyone else's answers — only how far each person has got.

If nothing got a yes, the room sees "No match this time" and **anyone in the room** can **Deal more cards** (a fresh deck; none of the cards already shown come back). "Swipe another round" on a result is anyone's too.

## Timing

- **Soft time limit** (2, 3 or 5 minutes — the starter's choice): the result comes as soon as every voter *who is here* has answered every card, or when the time is up, whichever is first. The host can add a minute or show the result early.
- **Away**: a member with no live connection and no request for 75 seconds is away — they do not hold up "everyone is done". The same person on the same device coming back takes their place again (a reload, a phone unlocked).
- **Leaving** takes that person's ballot with them. The host leaving hands the session to the next voter who is here; the last one out ends it.
- **Expiry**: a code nobody started swiping with expires after 20 minutes; a session nobody has looked at for 30 minutes ends; no session lasts more than 4 hours; an ended session still answers "ended" for 3 minutes, then the code is gone.

Sessions are in memory only: a session is an evening, not a record. A server restart ends them.

## Playing the pick

The room's screen is where the film plays. On the screen, **Play** starts it; when someone presses Play on a phone, the phone says "Starting on the TV" and the screen starts the film by itself (once). With no screen in the room, Play plays on the device it was pressed on. A library film plays straight away; a library series or a catalogue title opens its title page.

## The first-time explanation

Four short steps with a simple drawing each (start on the TV — join on your phones — swipe yes, maybe or no — the pick shows on the TV), skippable, shown once **per person** (remembered on the profile, `prefs.groupTutorialSeen`, so it is not shown again on another device). "How it works" opens it again at any time.

## API

See the header of `src/routes/group.js`. In short: `POST /api/profiles/:id/group` starts, `…/group/join` joins, `GET …/group/:code?device=` reads the session as that member sees it, and `…/group/:code/{settings,role,start,vote,search,add,finish,extend,pick,again,choose,leave,end}` do the rest. The socket message `group_watch { code, device, profileId, token }` subscribes a member's socket; the server then sends `group_update { code, rev }` whenever the session changed, and the client asks again.
