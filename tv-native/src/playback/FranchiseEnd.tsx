// [franchise] THE END OF A FILM: "Next in the Marvel Cinematic Universe" — the
// next film in the person's order (GET /api/franchises/next/:imdbId), offered
// at the moment an episode's Up next would be (the credits when known, else
// the runtime-scaled window; playerRules.ts upNextState) and taken away again
// when the viewer seeks back out of it. The TV and the phone share it (the
// phone's player is this player).
//
//   on the server   Play now, counting down 15 s ONLY when the person's "play
//                   the next" setting is on, they are not a party guest and the
//                   "Still watching?" run is not reached — then it plays the
//                   library copy the way Up next plays the next episode
//   not on server   Save & watch: its title page, which presses Save & watch
//                   once (Detail `save`) — nothing starts by itself here
//   (a show next)   Open / Choose episode: its title page
//
// The rules are franchiseRules.ts (planFranchiseEnd, franchiseEndStep). The
// player keeps the card in its state only from show to retract; the countdown
// lives here, so a second's tick re-renders this card and not the player.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Text, StyleSheet, TVFocusGuideView, View} from 'react-native';
import Focusable from '../components/Focusable';
import {api, FranchiseNext} from '../api';
import {franchiseEndStep, FR_WORDS, FranchiseEndPlan, isImdbId, readFranchiseNext} from '../franchiseRules';
import {isPhone} from '../formFactor';
import theme from '../theme';

const {colors, radius, fontSize, spacing} = theme;
const PHONE = isPhone();

export type FrEndCard = {next: FranchiseNext; plan: FranchiseEndPlan};

/** The player's half: call the returned `tick` from the progress handler. It
 *  asks the server once, a minute before the window opens, and calls
 *  `onShow(next)` / `onRetract()` as the window opens and is left. */
export function useFranchiseEnd(o: {
  /** a film (not an episode) */
  film: boolean;
  imdbId: string | null | undefined;
  title: string;
  year?: number | null;
  profileId: string | null | undefined;
  onShow: (next: FranchiseNext) => void;
  onRetract: () => void;
}) {
  const st = useRef({asked: false, shown: false, next: null as FranchiseNext | null, gen: 0});
  const live = useRef(o);
  live.current = o;
  // a new title in this player: everything starts over
  const key = `${o.film}|${o.imdbId || ''}|${o.title}`;
  useEffect(() => {
    st.current = {asked: false, shown: false, next: null, gen: st.current.gen + 1};
    return () => {
      st.current.gen += 1; // an answer landing after this is dropped
    };
  }, [key]);
  const ask = useCallback(() => {
    const s = st.current;
    const gen = s.gen;
    const c = live.current;
    const imdbP: Promise<string | null> = isImdbId(c.imdbId)
      ? Promise.resolve(c.imdbId)
      : c.title
        ? api.imdbFor('movie', c.title, c.year ?? null).then(r => (r && isImdbId(r.imdbId) ? r.imdbId : null))
        : Promise.resolve(null);
    imdbP
      .then(id => (id ? api.franchiseNext(id, c.profileId) : null))
      .then(r => {
        if (st.current.gen !== gen) return;
        st.current.next = readFranchiseNext(r);
      })
      .catch(() => {}); // decoration: no answer, no card
  }, []);
  return useCallback(
    (content: number, duration: number, creditsStart: number | null, paused: boolean) => {
      const c = live.current;
      if (!c.film) return;
      const s = st.current;
      const step = franchiseEndStep({content, duration, creditsStart, asked: s.asked, shown: s.shown, paused});
      if (step === 'ask') {
        s.asked = true;
        ask();
      } else if (step === 'show' && s.next) {
        s.shown = true;
        c.onShow(s.next);
      } else if (step === 'retract') {
        s.shown = false;
        c.onRetract();
      }
    },
    [ask],
  );
}

/** The card (the Up next card's box and buttons). */
export function FranchiseEndCard({
  card,
  onPlay,
  onLeave,
  onDismiss,
  onFocusChange,
}: {
  card: FrEndCard;
  /** play the next film's library copy; `byCountdown`: it ran out */
  onPlay: (byCountdown: boolean) => void;
  /** to its title page (Save & watch / Open / Choose episode) */
  onLeave: () => void;
  onDismiss: () => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const {plan} = card;
  const [left, setLeft] = useState<number | null>(plan.countdown);
  const fired = useRef(false);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  useEffect(() => {
    setLeft(plan.countdown);
    fired.current = false;
    if (plan.countdown == null) return;
    const t = setInterval(() => setLeft(n => (n == null ? n : n - 1)), 1000);
    return () => clearInterval(t);
  }, [card, plan.countdown]);
  useEffect(() => {
    if (left == null || left > 0 || fired.current) return;
    fired.current = true;
    onPlayRef.current(true);
  }, [left]);
  const play = plan.primary === 'play';
  const glyph = plan.primary === 'save' ? '⬇' : '▶';
  return (
    <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.card}>
      <Text style={styles.kicker} numberOfLines={1}>
        {plan.kicker}
      </Text>
      <Text style={styles.title} numberOfLines={2}>
        {plan.line}
      </Text>
      <View style={styles.actions}>
        <Focusable
          uiId={plan.primary === 'play' ? 'player.franchise.play' : plan.primary === 'save' ? 'player.franchise.save' : 'player.franchise.open'}
          round
          light
          ring="violet"
          hasTVPreferredFocus
          onFocusChange={onFocusChange}
          onPress={() => {
            if (play) {
              if (fired.current) return;
              fired.current = true;
              onPlay(false);
            } else onLeave();
          }}
          style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>{`${glyph}  ${plan.primaryLabel}`}</Text>
        </Focusable>
        <Focusable uiId="player.franchise.dismiss" round onFocusChange={onFocusChange} onPress={onDismiss} style={styles.btn}>
          <Text style={styles.btnText}>{left != null ? `${FR_WORDS.dismiss} (${Math.max(0, left)})` : FR_WORDS.dismiss}</Text>
        </Focusable>
      </View>
    </TVFocusGuideView>
  );
}

// the Up next card's own look (Player.tsx styles.upNext / btn / btnPrimary)
const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    right: PHONE ? 16 : spacing.pageX,
    bottom: PHONE ? 104 : 60,
    backgroundColor: 'rgba(13,14,24,0.97)',
    borderRadius: radius.l,
    padding: spacing.lg,
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.line,
  },
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '900', letterSpacing: 1},
  title: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', marginVertical: spacing.sm},
  actions: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm},
  btn: {backgroundColor: colors.surface, paddingVertical: 12, paddingHorizontal: 22},
  btnText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  btnPrimary: {backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 30},
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
});
