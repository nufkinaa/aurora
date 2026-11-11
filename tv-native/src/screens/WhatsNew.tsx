// "New" — what Aurora can do now on this TV, and how, one card per feature;
// the raw changelog from the server underneath. The nav dot goes out once
// this version's page has been opened (storage: newSeen).
import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {openJoinParty, openReport} from '../overlay';
import {api} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {useMe, goSection, markNewSeen} from '../navSection';
import {RootStackParamList} from '../navigation';
import {APP_VERSION} from '../update';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;

// THIS ROUND: the TV app version the sign-in round (auth-round, 2026-10-31) ships in — the
// one place to change: its cards say `since: ROUND`, and NEW_FROM = ROUND puts the New
// ribbon on them alone. (The website has the same cards: public/js/screens/whatsnew.js,
// ROUND there; its `webOnly` cards — AirPlay from an iPhone — have nothing to do on a TV.)
export const ROUND = '5.9.5';
const NEW_FROM = ROUND;
const cmpVersion = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
export const isNewCard = (f: {since?: string}) => !!f.since && cmpVersion(f.since, NEW_FROM) >= 0;

type Feature = {since?: string; glyph: string; title: string; what: string; how: string; go?: {label: string; act: string}};
export const FEATURES: Feature[] = [
  // ---- 5.9.5: Children mode, the same card, the same words, on the website ----
  {
    since: ROUND,
    glyph: '🧸',
    title: "Children mode",
    what: "One press cleans the feed for your child on every device signed in to your account: pick who is watching (All ages, 7+, 12+ or 16+) each time you turn it on. You choose a passcode the first time; leaving takes it. A younger age is one press, an older one asks for the passcode. Kids profiles are now Children mode.",
    how: "Settings → Children mode.",
    go: {label: 'Go home', act: 'home'},
  },
  // ---- 5.9.4 ----
  {
    since: '5.9.4',
    glyph: '▶️',
    title: "Continue Watching, tidied",
    what: "One card per show: the episode you watched last, whether it was downloaded or streamed. Anything you have finished leaves the row, and stopping in the end credits counts as finished. When you finish an episode, the card moves on to the next one you have not seen.",
    how: "Open Home: Continue Watching is the first row.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.4',
    glyph: '🔎',
    title: "Film or series, at a glance in search",
    what: "On the website, the TV and the phone app, every result and every suggestion in search now carries a small sign: a gold film strip for a film, a blue screen for a series. A show's page on the TV also lists its genres, as a film's page always did.",
    how: "Search → type a few letters.",
    go: {label: 'Search', act: 'search'},
  },
  // ---- the 2026-11-11 round: the same cards, the same words, on the website ----
  {
    since: '5.9.3',
    glyph: '🧾',
    title: "A report tells us what happened",
    what: "Report a problem now carries the last things you did, your device and what the player was doing, so a problem can be found without asking you questions. Nothing you type is recorded (no passwords, names or messages; the words of a search are the one exception), and you can read exactly what will be sent before you send it.",
    how: "Settings → Report a problem → See what will be sent.",
    go: {label: 'Report a problem', act: 'report'},
  },
  {
    since: '5.9.3',
    glyph: '🧹',
    title: "Small things put right",
    what: "A sweep through every screen: words that were cut, rows that sat too close to the edge, a clock that was hard to read, Back that went to the wrong place. Nothing has moved. It just sits right now.",
    how: "Nothing to do. Use Aurora as always.",
    go: {label: 'Go home', act: 'home'},
  },
  // ---- the 2026-11-10 round: the same card, the same words, on the website ----
  {
    since: '5.9.2',
    glyph: '🗓️',
    title: "The Calendar is a real month",
    what: "See the whole month at a glance: each release's poster on its day, a coloured edge for premieres, new episodes and films, and a tick for what's already on the server. Pick a day to see it in full, and Next up shows what's coming soonest. The list is still there: switch between Month and List.",
    how: "Press Left for the menu → Calendar. On the phone: More → Calendar.",
    go: {label: 'Open Calendar', act: 'calendar'},
  },
  // ---- [play-on-tv] Play on TV / Continue on this phone: the same card, the same words, on the website ----
  {
    since: '5.9.0',
    glyph: '📺',
    title: "Play on TV, and back to your phone",
    what: "Press Play on TV on a title, an episode or in the player, and the TV starts it at the same second: it wakes from its screensaver and opens your profile, asking for its PIN or password if it has one. Your phone or computer pauses and becomes the remote, and Continue on this phone brings it back.",
    how: "Leave this TV on, signed in or on the Who's watching? screen. On your phone or computer: Play on TV.",
    go: {label: 'Home', act: 'home'},
  },
  // ---- the 2026-11-09 round: the same cards, the same words, on the website ----
  {
    since: '5.9.1',
    glyph: '🎚️',
    title: "Pictures on the timeline",
    what: "Drag or skip and you see the moment you will land on. On the TV, hold left or right to glide, faster the longer you hold. The Next episode countdown is back at the credits, with Watch credits to stay.",
    how: "In the player: tap or hold left and right.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.1',
    glyph: '📅',
    title: "Calendar",
    what: "New episodes, season premieres and film release dates for everything in your list and the shows you follow, by day: Coming up and Recently out. It shows what is already on the server, with Play, and Save & watch for what is not.",
    how: "Press Left for the menu → Calendar.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.1',
    glyph: '🎞️',
    title: "Watch franchises in order",
    what: "A film's page now says where it sits in its franchise. Watch in order lists every film and series in order, with what's on the server and what you've seen, in release or story order. At the end of a film the next one is offered, and Home has Continue the franchise.",
    how: "Open a film from a franchise, then press Part of … under its buttons.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.0',
    glyph: '🍿',
    title: "Pick together",
    what: "What do we watch tonight? Start it on the TV, everyone joins with the code on their phone and swipes yes, maybe or no. Aurora shows what you all want, and one press plays it.",
    how: "AI → Pick together, or Settings → Pick together.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.0',
    glyph: '🔤',
    title: "Hebrew subtitles for everything",
    what: "When a film or episode has no Hebrew subtitles, Aurora translates one with AI. It is called עברית (AI) in the subtitle menu and switches on by itself. Subtitles out of sync? Fix timing lines them up with what is said, and you can always go back to the file's own timing.",
    how: "In the player: Subtitles → עברית (AI), or Fix timing.",
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.9.0',
    glyph: '🔎',
    title: "Search in Hebrew",
    what: "Type a title the way you say it, like פרנדס or ספיידרמן, or its Hebrew name, like שובר שורות, and Aurora finds it. Typed with the keyboard in the wrong language? It works that out too.",
    how: "Search → type in Hebrew, or press the microphone on the remote.",
    go: {label: 'Open Search', act: 'search'},
  },
  {
    since: '5.9.0',
    glyph: '🌙',
    title: "Tonight's episodes, ready tomorrow",
    what: "Aurora now downloads the next episode of the shows you are watching ahead of time, and at night makes it ready for your device, so it starts faster.",
    how: "Nothing to do: keep watching a show and its next episode is waiting.",
    go: {label: 'Go home', act: 'home'},
  },
  // ---- tv-reports-nov (2026-11-09: Bigmakdaddy's and Jesse's reports): the same cards, the same words, on the website ----
  {
    since: '5.9.0',
    glyph: '⬇️',
    title: "Save & watch saves, then plays",
    what: "On a title that isn't on the server yet, Save & watch downloads the best copy and the page shows how far it has got; Play plays it once it is in. Nothing streams from a torrent by itself, and the Home billboard never starts a download for you.",
    how: "Title page → Save & watch. My downloads shows it too.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    since: '5.9.0',
    glyph: '✍️',
    title: "Say what's wrong with a copy",
    what: "Pick Other under Problem with this copy and Aurora asks what is wrong first. Then you choose: get another version, or just send your words to the admin and keep the copy you have.",
    how: "In the player: the menu → Problem with this copy? → Other. Type it, or press Say it and speak.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  // ---- downloads-next (2026-11-06): the same cards, the same words, on the website ----
  {
    since: '5.9.0',
    glyph: '🎧',
    title: "Checked for the right language",
    what: "When a copy you reported as Wrong language arrives, Aurora reads its sound tracks first. If it is in the wrong language again, it is not swapped in and the next version is fetched. If the copy doesn't say its language, it is swapped in and Aurora tells you so.",
    how: "In the player: Report a problem → Problem with this copy → Wrong language. The new copy is checked before it replaces yours.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    since: '5.9.0',
    glyph: '🔔',
    title: "Tell me when it's ready",
    what: "When something you asked for has downloaded, Aurora says so on the website, the TV and the phone. Switch it off once and it is off on every device you use.",
    how: "Settings → Notifications → Tell me when it's ready.",
    go: {label: 'Settings', act: 'settings'},
  },
  // ---- Niso's reports (2026-11-02): the same cards, the same words, on the website ----
  {
    since: '5.8.3',
    glyph: '⏹️',
    title: "Cancel a download, anywhere",
    what: "Cancel is on My downloads, on the title page and on the versions list, and it always asks first, so a stray press changes nothing. What is on its way now sits at the top of My downloads.",
    how: "My downloads or the title page → Cancel download → Yes, cancel.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    since: '5.8.3',
    glyph: '🔢',
    title: "See how many downloads you have",
    what: "One line shows yours: how many are downloading, how many are waiting and how many are ready. It only counts them; there is no limit.",
    how: "Settings, and the top of My downloads.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    since: '5.8.3',
    glyph: '🗣️',
    title: "Wrong language? It looks for the right one",
    what: "Report a copy as Wrong language and the list leaves out copies naming that language, with the language you want first. If a try is cancelled or fails, Aurora says who or why and offers the next version.",
    how: "In the player: Report a problem → Problem with this copy → Wrong language.",
    go: {label: 'My downloads', act: 'downloads'},
  },
  // ---- the sign-in round (2026-10-31): the same cards, the same words, on the website ----
  {
    since: '5.8.2',
    glyph: '🔑',
    title: 'Forgot your password? Reset it yourself',
    what: "Forgot password? on the sign-in screen lets you choose a new password without the old one. Confirm it's you with Google, ask the admin and carry on here as soon as they approve, or type the reset code they give you. Every other device is signed out unless you untick it.",
    how: 'Sign-in screen → Forgot password?. Still signed in on your phone or computer? Change it there, in Settings.',
    go: {label: 'Open Settings', act: 'settings'},
  },
  {
    since: '5.8.2',
    glyph: '🛡️',
    title: 'Every profile has a password',
    what: 'Requests made with Google now set a password as well, so you can sign in on devices without Google. A profile that only had Google is asked to set one at its next sign-in.',
    how: 'Sign-in screen → Request access → Sign up with Google.',
    go: {label: 'Open Settings', act: 'settings'},
  },
  {
    since: '5.8.2',
    glyph: '✨',
    title: 'A clearer sign-in screen',
    what: 'Sign in and Request access have the same look on the TV, the website and the phone app: a label on every field, the reason next to the field when something is wrong, Show to see the password you typed, and the code to scan with your phone beside it.',
    how: 'Shown when this TV needs to sign in.',
    go: {label: 'Go home', act: 'home'},
  },
  // ---- end of the sign-in round ----
  // ---- the household-recommendations round (2026-10-27): the same card, the same words, on the website ----
  {
    since: '5.7.0',
    glyph: '📨',
    title: 'Recommend to your household',
    what: 'Send a film or a show to someone in your household, with a short note if you like. What the others recommend to you sits on Home under Recommended for You, the titles more of them recommended first, and one press puts it on your My List.',
    how: 'On any title press Recommend, pick the faces with OK and press Send. On Home, hold OK on a recommended card for Add to My List or Not for me. To mute someone: Settings → Recommendations.',
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.7.0',
    glyph: '📬',
    title: 'See what became of your picks',
    what: 'Show all recommended lists everything the household recommended to you, by person, and its second tab what you sent: whether each person saw it, put it on their list or watched it. Not for me tells nobody.',
    how: 'Settings → Recommendations → What you sent. Show all recommended also ends the row on Home once there are more than 15.',
    go: {label: 'Open Settings', act: 'settings'},
  },
  // ---- end of the household-recommendations round ----
  // ---- the watch-party round (2026-10-27): the same cards, the same words, on the website ----
  {
    since: '5.6.0',
    glyph: '👥',
    title: 'Watch together, calmly',
    what: "Everyone in a watch party joins in step and stays there: a pause, a play or a jump reaches the whole room, and nobody's film speeds up or slows down. When a friend's film stalls, the party waits for them and starts again together. Share the invite, send a reaction, and a host who has to go hands the party to the next person.",
    how: 'In the player press the 👥 button → Start a party and share the four-letter code. The reactions sit in the same menu; to go while the others watch on, press Leave — the next person hosts. Here, Settings → Join a watch party.',
    go: {label: 'Join a party', act: 'join'},
  },
  {
    since: '5.6.0',
    glyph: '⏯️',
    title: 'Fewer freezes mid-film',
    what: 'A film that stops because the connection went quiet for a moment picks up again by itself in a few seconds, where it was, instead of freezing for half a minute or starting over from the beginning.',
    how: 'Nothing to do: the TV gives up on a connection that stopped answering and carries on over a new one.',
    go: {label: 'Open Movies', act: 'movies'},
  },
  // ---- end of the watch-party round ----
  // ---- the reports round (2026-10-26): the same cards, the same words, on the website ----
  {
    since: '5.5.0',
    glyph: '🎞️',
    title: 'Get another version',
    what: "A copy with burned-in subtitles, a bad picture, bad sound or the wrong language? Say what is wrong and pick another version: it downloads and takes the old copy's place, and your place, My List and ratings stay. The copy you have plays until the new one is in.",
    how: 'On a film you own: Problem with this copy?, to the right of Versions. For an episode, hold OK on it; in the player: Help → Problem with this copy?',
    go: {label: 'Open Movies', act: 'movies'},
  },
  {
    since: '5.5.0',
    glyph: '🎬',
    title: 'Cinema copies are never picked for you',
    what: 'A film that is only out as a cinema recording says "Not out in good quality yet" instead of downloading it. Those copies are marked CAM or TS and asked about first, and nothing Aurora picks for you is ever one of them. Adding a film to My List no longer downloads it.',
    how: 'Open a film that is still in cinemas: the line sits under its button, which reads ≡ Sources, and the sources there carry the mark.',
    go: {label: 'Open Movies', act: 'movies'},
  },
  {
    since: '5.5.0',
    glyph: '🔎',
    title: "Search that doesn't give up",
    what: "When the catalogue is slow, search keeps the matches from your library on screen, says Still searching… and tries again by itself, so a film is no longer “not found” only because the answer came late. If the catalogue can't be reached, it says so, with Try again.",
    how: 'Nothing to do. When the catalogue did not answer, Try again sits right above the results.',
    go: {label: 'Open Search', act: 'search'},
  },
  // ---- end of the reports round ----
  // ---- the TV round (2026-10-19/20): the same cards, the same words, on the website ----
  {
    since: '5.4.0',
    glyph: '🎞️',
    title: 'The screen follows the film',
    what: 'A film made at 24 frames a second plays at 24 on the TV, so slow pans glide instead of stuttering. The TV switches its refresh rate while the film plays and back when you leave.',
    how: 'Nothing to do. To turn it off for you: Settings → Picture and sound → Match frame rate.',
    go: {label: 'Picture and sound', act: 'settings'},
  },
  {
    since: '5.4.0',
    glyph: '🔊',
    title: 'Dolby sound, as it is',
    what: 'Films with Dolby or DTS sound go to your TV or soundbar as they are, in full surround, and most films now play straight from the file — the server makes fewer copies, so they start sooner.',
    how: 'Nothing to do. For plain stereo: Settings → Picture and sound → Surround sound.',
    go: {label: 'Picture and sound', act: 'settings'},
  },
  {
    since: '5.4.0',
    glyph: '🌙',
    title: 'Night mode and dialogue boost',
    what: 'Night mode brings loud bursts down and quiet voices up, for late evenings; dialogue boost makes voices clearer over music and effects. Your choice follows you to every screen.',
    how: 'In the player: ⚙ → Audio, or Settings → Sound. Greyed while the sound goes to your TV or receiver as it is (Dolby or DTS passthrough).',
    go: {label: 'Sound settings', act: 'settings'},
  },
  {
    since: '5.4.0',
    glyph: '💬',
    title: 'Subtitles your way',
    what: 'Choose the size, colour, background and position of subtitles once — the TV and every browser show them the same way.',
    how: 'In the player: Subtitles → Subtitle style, with a live sample. Or Settings → Subtitles.',
    go: {label: 'Subtitle settings', act: 'settings'},
  },
  {
    since: '5.4.0',
    glyph: '📱',
    title: 'Your phone is the remote',
    what: 'Steer the TV from your phone — swipe to move, tap for OK, pause, scrub, subtitles and sound — and send any film to the TV with Play on TV, at the second you were at.',
    how: "Open Aurora on your phone, signed in to this profile: this TV shows up under Remote. Settings → This TV's name sets what your phone calls it.",
    go: {label: "This TV's name", act: 'settings'},
  },
  {
    since: '5.4.0',
    glyph: '🎙️',
    title: 'Search by voice',
    what: 'Say a title instead of typing it, in Hebrew or English — "Breaking Bad season two" goes straight to the show.',
    how: 'On Search press Voice, or the microphone button on the remote. On the website: the microphone in the search field.',
    go: {label: 'Open Search', act: 'search'},
  },
  {
    since: '5.4.0',
    glyph: '⚡',
    title: 'Home opens at once',
    what: 'Home appears straight away with what you saw last time, and fresh news slips in without moving the row you are looking at.',
    how: 'Nothing to do.',
    go: {label: 'Go home', act: 'home'},
  },
  {
    since: '5.4.0',
    glyph: '🧈',
    title: 'Smoother on the TV',
    what: 'Holding a direction on the remote glides through shelves and grids at an even pace, the words on the cards are drawn sooner, and no card turns up late at the end of a row.',
    how: 'Nothing to do. A held key now moves 15 steps a second, evenly, and stops where you let go.',
    go: {label: 'Go home', act: 'home'},
  },
  // ---- end of the TV round ----
  {
    glyph: '🎬',
    title: 'Trailers on the billboard',
    what: 'Let a title sit on the home hero for a few seconds and its trailer plays, quietly, then the billboard moves on.',
    how: 'Press Unmute beside Details for sound. Moving down to the shelves or opening the menu ends it. Off under Settings → Playback.',
    go: {label: 'Go home', act: 'home'},
  },
  {
    glyph: '👥',
    title: 'Watch together',
    what: 'A few devices, one title, in step. Play, pause and jumps happen for everyone.',
    how: 'In the player press the 👥 button → Start a party and share the four-letter code. Others join from their profile menu; here, Settings → Join a watch party. Up next carries the whole room along.',
    go: {label: 'Join a party', act: 'join'},
  },
  {
    glyph: '⏭',
    title: 'Skip intro, Up next — detected',
    what: 'Aurora listens to every episode and finds the theme and the credits by itself, so the buttons appear at the right moment.',
    how: 'Wrong on a show? Player gear → Ignore the detected intro, or mark it by hand: Mark intro start, then Intro ends here.',
    go: {label: 'Open Shows', act: 'shows'},
  },
  {
    glyph: '💬',
    title: 'Subtitles that find themselves',
    what: 'Pick a language once. A title you own that lacks it gets one fetched and switched on while it starts.',
    how: 'Settings → Subtitles → Preferred subtitle language.',
    go: {label: 'Set a language', act: 'settings'},
  },
  {
    glyph: '👆',
    title: 'Hold a card to peek',
    what: 'Hold OK on any poster and the title opens as a sheet: what it is, how much is left, the synopsis.',
    how: 'Play, Details and My List are right there. Back puts you exactly where you were.',
    go: {label: 'Try it on Movies', act: 'movies'},
  },
  {
    glyph: '▶️',
    title: 'Resume, with the frame',
    what: 'Coming back to a title shows the frame you stopped on, with Start over one press away for four seconds — on a smaller, quieter card.',
    how: 'Nothing to set up — it appears whenever there is a place to resume.',
  },
  {
    glyph: '⬇',
    title: 'My downloads',
    what: 'Everything you asked the server to fetch, in one place: ready to play, on its way, waiting on an admin.',
    how: 'Settings → My downloads. A finished one plays from there.',
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    glyph: '🔄',
    title: 'Updates on the TV',
    what: 'When a new version of this app is published, Home offers it and it installs right here — no computer needed.',
    how: 'Settings → This TV shows the version and checks again.',
    go: {label: 'Check now', act: 'settings'},
  },
  {
    glyph: '🛠️',
    title: 'Report a problem',
    what: 'A few words is enough. Where you were, what was playing and the last errors this TV saw come along by themselves.',
    how: 'Settings → Report a problem.',
    go: {label: 'Report something', act: 'report'},
  },
];

export default function WhatsNew({navigation}: NativeStackScreenProps<RootStackParamList, 'WhatsNew'>) {
  const {profileId} = useApp();
  const me = useMe(profileId);
  const {safeBottom} = useTvMetrics();
  const [log, setLog] = useState<{version: string; date: string | null; items: string[]}[] | null>(null);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(true);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .changelog()
      .then(c => {
        if (!live) return;
        setLog(c.releases || []);
        markNewSeen(c.version || APP_VERSION);
      })
      .catch(() => live && markNewSeen(APP_VERSION));
    return () => {
      live = false;
    };
  }, []);

  const act = (a: string) => {
    if (a === 'join') return openJoinParty();
    if (a === 'report') return openReport();
    if (a === 'downloads') return navigation.push('Downloads');
    if (a === 'home' || a === 'movies' || a === 'shows' || a === 'settings' || a === 'search' || a === 'calendar') goSection(navigation, 'new', a);
  };

  return (
    <View style={styles.root}>
      <NavRail active="new" />
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, {paddingBottom: safeBottom + spacing.xl}]}>
        <Text style={styles.kicker}>{`AURORA TV ${APP_VERSION}`}</Text>
        <Text style={styles.h1}>New in Aurora</Text>
        <Text style={styles.sub}>{`Hi ${me?.name || 'there'} — here's what this TV can do now, and how.`}</Text>
        <View style={styles.grid}>
          {FEATURES.map((f, i) => (
            <Focusable uiId="whatsnew.go"
              key={f.title}
              scaleTo={1.02}
              lift={2}
              edgeLeft={i % 2 === 0}
              hasTVPreferredFocus={i === 0}
              highlightColor={colors.surfaceHover}
              onPress={() => f.go && act(f.go.act)}
              style={styles.card}>
              <View style={styles.cue}>
                <Text style={styles.glyph}>{f.glyph}</Text>
              </View>
              <View style={styles.cardBody}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{f.title}</Text>
                  {isNewCard(f) ? <Text style={styles.ribbon}>NEW</Text> : null}
                </View>
                <Text style={styles.what}>{f.what}</Text>
                <Text style={styles.how}>
                  <Text style={styles.howLabel}>How </Text>
                  {f.how}
                </Text>
                {f.go ? <Text style={styles.go}>{`${f.go.label} ›`}</Text> : null}
              </View>
            </Focusable>
          ))}
        </View>

        <Focusable uiId="whatsnew.log"
          round
          edgeLeft
          onPress={() => setShowLog(s => !s)}
          highlightColor={colors.surfaceHover}
          style={styles.logBtn}>
          <Text style={styles.logBtnText}>{showLog ? 'Hide the full changelog' : 'Full changelog'}</Text>
        </Focusable>
        {showLog && log
          ? log.slice(0, 8).map(r => (
              <View key={r.version} style={styles.release}>
                <Text style={styles.relHead}>{`${r.version}${r.date ? ` — ${r.date}` : ''}`}</Text>
                {r.items.map((it, i) => (
                  // (the changelog is written in Markdown: the site draws
                  // **bold**, this list printed the asterisks)
                  <Text key={i} style={styles.relItem}>{`•  ${it.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')}`}</Text>
                ))}
              </View>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  scroll: {flex: 1},
  content: {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 27},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: 4},
  sub: {color: colors.textDim, fontSize: fontSize.body, marginTop: 2, marginBottom: spacing.md},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 14},
  card: {
    width: '48.5%',
    flexDirection: 'row',
    gap: 14,
    padding: 16,
    borderRadius: radius.l,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderTopColor: 'rgba(255,255,255,0.16)',
  },
  cue: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(139,123,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {fontSize: 26},
  cardBody: {flex: 1, minWidth: 0},
  cardHead: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8},
  cardTitle: {color: colors.text, fontSize: fontSize.body, fontWeight: '800', flexShrink: 1},
  // the website's ribbon (.wn-ribbon): small caps, mint
  ribbon: {color: '#86efac', fontSize: 11, fontWeight: '900', letterSpacing: 1.2},
  what: {color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: 4},
  how: {color: colors.textFaint, fontSize: 14, lineHeight: 20, marginTop: 6},
  howLabel: {color: colors.textDim, fontWeight: '800'},
  go: {color: colors.accent, fontSize: 14, fontWeight: '800', marginTop: 8},
  logBtn: {alignSelf: 'flex-start', backgroundColor: colors.surface, paddingVertical: 10, paddingHorizontal: 20, marginTop: spacing.xl},
  logBtnText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  release: {marginTop: spacing.lg, maxWidth: 820},
  relHead: {color: colors.text, fontSize: fontSize.body, fontWeight: '800', marginBottom: 6},
  relItem: {color: colors.textDim, fontSize: 14, lineHeight: 21, marginBottom: 6},
});
