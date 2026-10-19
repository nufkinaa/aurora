// What one remote command does, and the answer it gets — PURE: everything it
// touches comes in through `ctx` (the player while one is up, the native
// keys and volume, opening a title, the toast), so every rule here is pinned
// by __tests__/logic/remote-handler.test.ts without a TV.
//
// The rules:
//   - EVERY command is answered, exactly once (`answer` below: a handler that
//     throws, or never finishes, still acks — ok:false, "failed" / "timeout").
//   - A transport command (play, pause, seek, a track…) with no player up is
//     {ok:false, error:"nothing-playing"}; a player that is up but has not
//     loaded its title yet is "not-ready".
//   - The first command from a remote shows "Controlled from Elia's iPhone"
//     once (the server's `first`; the TV remembers who it has named, so a
//     socket that reconnects does not say it again).
//   - The arguments arrive checked and bounded by the server (devices.js
//     COMMANDS); they are checked again here only for what could hurt.
import {MSG, type Ack, type CommandMsg, type From, type NowState, type Outcome, type PlayItemArgs, type RemoteKey, type VolumeState, KEYS} from './protocol';

/** The player while it is up (Player.tsx registers one — remote/player.ts). */
export type RemotePlayer = {
  /** null: mounted, but the title is not loaded yet */
  now: () => NowState | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  /** where a skip counts from: a seek on its way, else the clock */
  position: () => number;
  seekTo: (sec: number) => void;
  /** false: nothing is next */
  next: () => boolean;
  /** null = off; false: no such track */
  setSub: (id: string | null) => boolean;
  /** false: no such track */
  setAudio: (id: string) => boolean;
  subDelay: () => number;
  /** false: no subtitle track is on */
  setSubDelay: (seconds: number) => boolean;
};

export type RemoteVolume = {
  get: () => Promise<VolumeState | null>;
  set: (level: number) => Promise<unknown>;
  step: (dir: 1 | -1) => Promise<unknown>;
  mute: (on: boolean) => Promise<unknown>;
};

export type HandlerCtx = {
  player: () => RemotePlayer | null;
  appState: () => 'active' | 'background';
  /** a real key press into the activity (null: the native module is not in this build) */
  press: ((key: Exclude<RemoteKey, 'home'>) => Promise<boolean>) | null;
  /** back to Home (pop to the top of the stack) */
  home: () => boolean;
  volume: RemoteVolume | null;
  playItem: (args: PlayItemArgs) => Promise<Outcome>;
  rename: (name: string) => void | Promise<unknown>;
  toast: (text: string, glyph: string) => void;
  /** who this TV has already named in the toast */
  seen: Set<string>;
};

const ok = (message?: string): Outcome => (message ? {ok: true, message} : {ok: true});
const no = (error: string, message?: string): Outcome => (message ? {ok: false, error, message} : {ok: false, error});

/** "Elia's iPhone", or just "iPhone" with no name (the website's whoFrom). */
export const whoFrom = (from: From | null | undefined): string => {
  const label = (from && typeof from.label === 'string' && from.label.trim()) || 'your phone';
  const name = from && typeof from.profileName === 'string' ? from.profileName.trim() : '';
  return name ? `${name}'s ${label}` : label;
};

/** The "Controlled from …" toast, once per remote. True when it was shown. */
export const noteFirst = (msg: CommandMsg, ctx: Pick<HandlerCtx, 'seen' | 'toast'>): boolean => {
  if (!msg.first) return false;
  const who = whoFrom(msg.from);
  if (ctx.seen.has(who)) return false;
  ctx.seen.add(who);
  ctx.toast(`Controlled from ${who}`, '📱');
  return true;
};

const numArg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const TRANSPORT = new Set(['play', 'pause', 'toggle', 'stop', 'next', 'seek', 'skip', 'sub', 'audio', 'sub_delay']);

/** What the command does. Never throws on its own account (the ctx may). */
export async function runCommand(msg: CommandMsg, ctx: HandlerCtx): Promise<Outcome> {
  const a = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>;
  const cmd = msg.cmd;

  // ---- what needs no player
  if (cmd === 'play_item') {
    const item = a.item as PlayItemArgs['item'] | undefined;
    if (!item || typeof item.id !== 'string' || !item.id) return no('bad-command', MSG.badCommand);
    return ctx.playItem({
      item,
      position: numArg(a.position),
      restart: a.restart === true,
      subLang: typeof a.subLang === 'string' ? a.subLang : null,
      audioLang: typeof a.audioLang === 'string' ? a.audioLang : null,
    });
  }
  if (cmd === 'key') {
    const key = a.key as RemoteKey;
    if (!(KEYS as readonly string[]).includes(key)) return no('bad-command', MSG.badCommand);
    if (ctx.appState() !== 'active') return no('background', MSG.background);
    if (key === 'home') return ctx.home() ? ok() : no('failed', MSG.failed);
    if (!ctx.press) return no('unsupported', MSG.noKeys);
    return (await ctx.press(key)) ? ok() : no('failed', MSG.failed);
  }
  if (cmd === 'rename') {
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 40) : '';
    if (!name) return no('bad-command', MSG.badCommand);
    await ctx.rename(name);
    return ok();
  }
  if (cmd === 'volume' || cmd === 'mute') {
    const v = ctx.volume;
    const now = v ? await v.get() : null;
    if (!v || !now || !now.supported) return no('unsupported', MSG.noVolume);
    if (cmd === 'mute') {
      await v.mute(a.on !== false);
      return ok();
    }
    const level = numArg(a.level);
    if (level != null) {
      await v.set(Math.max(0, Math.min(1, level)));
      return ok();
    }
    if (a.step === 1 || a.step === -1) {
      await v.step(a.step);
      return ok();
    }
    return no('bad-command', MSG.badCommand);
  }
  if (!TRANSPORT.has(cmd)) return no('bad-command', MSG.badCommand);

  // ---- the player's
  const p = ctx.player();
  if (!p) return no('nothing-playing', MSG.nothingPlaying);
  if (cmd === 'stop') {
    p.stop();
    return ok();
  }
  const n = p.now();
  if (!n) return no('not-ready', MSG.notReady);
  switch (cmd) {
    case 'play':
      if (n.paused) p.play();
      return ok();
    case 'pause':
      if (!n.paused) p.pause();
      return ok();
    case 'toggle':
      p.toggle();
      return ok();
    case 'next':
      if (!n.hasNext) return no('no-next', MSG.noNext);
      return p.next() ? ok() : no('no-next', MSG.noNext);
    case 'seek': {
      const to = numArg(a.to);
      if (to == null) return no('bad-command', MSG.badCommand);
      if (!n.canSeek) return no('cannot-seek', MSG.cannotSeek);
      p.seekTo(clampTo(to, n.duration));
      return ok();
    }
    case 'skip': {
      const by = numArg(a.by);
      if (by == null || by === 0) return no('bad-command', MSG.badCommand);
      if (!n.canSeek) return no('cannot-seek', MSG.cannotSeek);
      p.seekTo(clampTo(p.position() + by, n.duration));
      return ok();
    }
    case 'sub': {
      const id = a.id === null || a.id === 'off' ? null : typeof a.id === 'string' ? a.id : undefined;
      if (id === undefined) return no('bad-command', MSG.badCommand);
      return p.setSub(id) ? ok() : no('no-such-track', MSG.noTrack);
    }
    case 'audio': {
      if (typeof a.id !== 'string' || !a.id) return no('bad-command', MSG.badCommand);
      return p.setAudio(a.id) ? ok() : no('no-such-track', MSG.noTrack);
    }
    case 'sub_delay': {
      if (n.sub == null) return no('no-subtitles', MSG.noSubs);
      const value = numArg(a.value);
      const by = numArg(a.by);
      const next = value != null ? value : by != null ? p.subDelay() + by : null;
      if (next == null) return no('bad-command', MSG.badCommand);
      return p.setSubDelay(Math.max(-600, Math.min(600, next))) ? ok() : no('no-subtitles', MSG.noSubs);
    }
  }
  return no('bad-command', MSG.badCommand);
}

// within the title (a second short of its end, as the player's own seekTo)
const clampTo = (sec: number, duration: number) => Math.max(0, duration > 0 ? Math.min(duration - 1, sec) : sec);

/** Comfortably inside the server's ACK_MS (6 s), so the server never has to
 *  answer "didn't answer" for a TV that is alive. */
export const ANSWER_MS = 4500;

/** Runs the command and sends its ack — ALWAYS, exactly once: a handler that
 *  throws answers ok:false "failed", one that hangs answers ok:false "timeout"
 *  after ANSWER_MS (whatever it does later is not answered again). */
export function answer(
  msg: CommandMsg,
  ctx: HandlerCtx,
  send: (ack: Ack) => void,
  timers: {setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void} = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): Promise<Ack> {
  const ref = String(msg.ref || '');
  let done = false;
  return new Promise<Ack>(resolve => {
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      const ack: Ack = {type: 'remote_ack', ref, ok: !!o.ok};
      if (!o.ok) ack.error = o.error || 'failed';
      if (o.message) ack.message = o.message;
      try {
        send(ack);
      } catch {}
      resolve(ack);
    };
    const timer = timers.setTimeout(() => finish(no('timeout', MSG.failed)), ANSWER_MS);
    try {
      noteFirst(msg, ctx);
    } catch {}
    let run: Promise<Outcome>;
    try {
      run = runCommand(msg, ctx);
    } catch (e) {
      console.log('[remote] command threw:', msg.cmd, (e as Error)?.message);
      finish(no('failed', MSG.failed));
      return;
    }
    run.then(
      o => finish(o || no('failed', MSG.failed)),
      e => {
        console.log('[remote] command failed:', msg.cmd, (e as Error)?.message);
        finish(no('failed', MSG.failed));
      },
    );
  });
}

/** Key presses one after another, never closer than `gapMs` apart — however
 *  the network bunched them. (MainActivity drops a second press of the same
 *  D-pad key within 110 ms, as it must for a bouncy remote: two phone presses
 *  that arrive together must not look like one.) */
export function createPacer<K>(
  press: (key: K) => Promise<boolean>,
  gapMs: number,
  clock: {now: () => number; sleep: (ms: number) => Promise<void>} = {
    now: () => Date.now(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  },
) {
  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = -Infinity;
  return (key: K): Promise<boolean> => {
    const run = chain.then(async () => {
      const wait = lastAt + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastAt = clock.now();
      return press(key);
    });
    chain = run.catch(() => false);
    return run.then(r => !!r, () => false);
  };
}
