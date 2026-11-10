// This app, as a report says it (reportFields.ts has the shape) — and, since
// the report trail (docs/report-trail.md), what the viewer did before, what
// this device is and what the player was doing: every report this app files
// ("Report a problem", "Problem with this copy?") carries them. Each part is
// read on its own; one that fails is only missing.
import {Dimensions, Platform} from 'react-native';
import {getAuthMode, getBaseUrl, getSession} from './api';
import {playingContext, recentErrors} from './errors';
import {isPhone} from './formFactor';
import {isLowRam} from './perfTier';
import {isOpen} from './realtime';
import {versionCode} from './render';
import {appFacts, clientFields} from './reportFields';
import {currentRouteName, rootNav} from './rootNav';
import {recentRequests, sessionMs, trailTake} from './trail';
import {trailText} from './trailCore';
import {APP_VERSION, PHONE_APP_VERSION} from './update';

const read = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export const clientContext = () => {
  const c = Platform.constants as {Model?: string; Release?: string; Brand?: string; Manufacturer?: string};
  const sentAt = Date.now();
  const phone = isPhone();
  const playing = playingContext();
  return {
    ...clientFields({
      phone,
      tvVersion: APP_VERSION,
      phoneVersion: PHONE_APP_VERSION,
      release: c.Release,
      model: c.Model,
      // (whether the app's socket to the server is up)
      online: isOpen(),
      errors: recentErrors(),
    }),
    // [report trail]
    profileId: read(() => rootNav().profileId),
    trail: read(() => trailTake({sentAt})) || [],
    env: read(() =>
      appFacts({
        phone,
        version: phone ? PHONE_APP_VERSION : APP_VERSION,
        build: versionCode,
        release: c.Release,
        api: Platform.Version,
        brand: c.Manufacturer || c.Brand,
        model: c.Model,
        screen: read(() => Dimensions.get('screen')),
        window: read(() => Dimensions.get('window')),
        locale: read(() => Intl.DateTimeFormat().resolvedOptions().locale),
        tz: read(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
        lowRam: read(isLowRam),
        auth: read(getAuthMode),
        signedIn: read(() => !!getSession()),
        server: read(getBaseUrl),
        socket: read(isOpen),
        upMs: sessionMs(),
      }),
    ),
    player: read(() => (playing && playing.state ? playing.state() : null)),
    reqs: read(() => recentRequests(sentAt)) || [],
  };
};

// What "Report a problem" sends (both apps, both sheets of it): the context
// above, and where the viewer is and what is playing.
export const reportContext = (kind: 'tv' | 'phone') => {
  const playing = playingContext();
  return {
    ...clientContext(),
    route: `${kind}:${currentRouteName()}`,
    title: playing ? playing.title : null,
    itemId: playing ? playing.id : null,
    // what is playing, how it started: step by step from the press (src/startline.ts)
    startup: playing && playing.startup ? playing.startup() : null,
  };
};
export type ReportContext = ReturnType<typeof reportContext>;

// "See what will be sent", in plain words (trailCore.ts: the site's words).
// `steps`: only the newest that many (the TV's sheet has no room to scroll).
export const reportPeek = (ctx: ReportContext, o: {steps?: number} = {}) => {
  const all = ctx.trail || [];
  const steps = o.steps && all.length > o.steps ? all.slice(-o.steps) : all;
  return [
    `Where: ${ctx.route}${ctx.title ? ` · playing ${ctx.title}` : ''}`,
    steps.length < all.length ? `(${all.length - steps.length} earlier steps go too)` : '',
    trailText({trail: steps, env: ctx.env, player: ctx.player, reqs: o.steps ? [] : ctx.reqs}),
    ctx.errors && ctx.errors.length ? `Errors this app saw:\n${ctx.errors.map(e => `  ${e}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
};
