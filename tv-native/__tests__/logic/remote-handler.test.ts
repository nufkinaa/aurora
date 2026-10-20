// The phone remote's commands on the TV (src/remote/handler.ts): what each one
// does, and that every one is answered — exactly once, even when the code
// behind it throws or never finishes.
import {answer, createPacer, noteFirst, runCommand, whoFrom, ANSWER_MS, type HandlerCtx, type RemotePlayer} from '../../src/remote/handler';
import type {Ack, CommandMsg, NowState, VolumeState} from '../../src/remote/protocol';
import {MSG} from '../../src/remote/protocol';

const nowState = (o: Partial<NowState> = {}): NowState => ({
  id: 'm1',
  title: 'Dune',
  showTitle: null,
  epTitle: null,
  season: null,
  episode: null,
  poster: '/img/m1.jpg',
  backdrop: null,
  duration: 6000,
  position: 100,
  paused: false,
  buffering: false,
  canSeek: true,
  hasNext: false,
  nextLabel: null,
  subs: [{id: 'English', label: 'English', lang: 'en'}],
  sub: null,
  audios: [],
  audio: null,
  subDelay: 0,
  ...o,
});

type Calls = string[];
const fakePlayer = (calls: Calls, n: NowState | null = nowState(), over: Partial<RemotePlayer> = {}): RemotePlayer => {
  let state = n;
  return {
    now: () => state,
    play: () => {
      calls.push('play');
      if (state) state = {...state, paused: false};
    },
    pause: () => {
      calls.push('pause');
      if (state) state = {...state, paused: true};
    },
    toggle: () => calls.push('toggle') && undefined,
    stop: () => calls.push('stop') && undefined,
    position: () => (state ? state.position : 0),
    seekTo: s => calls.push(`seekTo ${s}`) && undefined,
    next: () => (calls.push('next'), true),
    setSub: id => (calls.push(`sub ${id}`), id === null || (state?.subs || []).some(t => t.id === id)),
    setAudio: id => (calls.push(`audio ${id}`), (state?.audios || []).some(t => t.id === id)),
    subDelay: () => state?.subDelay || 0,
    setSubDelay: v => (calls.push(`delay ${v}`), true),
    ...over,
  };
};

const ctxWith = (o: Partial<HandlerCtx> & {calls?: Calls} = {}): HandlerCtx & {toasts: string[]; calls: Calls} => {
  const calls = o.calls || [];
  const toasts: string[] = [];
  let vol: VolumeState = {supported: true, level: 0.5, muted: false, scope: 'system'};
  return {
    player: () => null,
    appState: () => 'active',
    press: async k => (calls.push(`press ${k}`), true),
    home: () => (calls.push('home'), true),
    volume: {
      get: async () => vol,
      set: async l => {
        calls.push(`volume ${l}`);
        vol = {...vol, level: l};
      },
      step: async d => calls.push(`step ${d}`),
      mute: async on => calls.push(`mute ${on}`),
    },
    playItem: async a => (calls.push(`play_item ${a.item.id}`), {ok: true, message: MSG.opening}),
    rename: name => void calls.push(`rename ${name}`),
    toast: (t, g) => void toasts.push(`${g} ${t}`),
    seen: new Set(),
    ...o,
    toasts,
    calls,
  };
};

const cmd = (c: string, args: Record<string, unknown> = {}, extra: Partial<CommandMsg> = {}): CommandMsg => ({
  type: 'remote_command',
  ref: 'r1',
  cmd: c,
  args,
  from: {label: 'iPhone', profileName: 'Elia'},
  first: false,
  ...extra,
});

describe('transport commands with nothing playing', () => {
  for (const c of ['play', 'pause', 'toggle', 'stop', 'next', 'seek', 'skip', 'sub', 'audio', 'sub_delay']) {
    test(`${c} → nothing-playing`, async () => {
      const ctx = ctxWith();
      const args = c === 'seek' ? {to: 10} : c === 'skip' ? {by: 10} : c === 'sub' ? {id: null} : c === 'audio' ? {id: '0'} : c === 'sub_delay' ? {by: 0.5} : {};
      expect(await runCommand(cmd(c, args), ctx)).toEqual({ok: false, error: 'nothing-playing', message: 'Nothing is playing on the TV'});
    });
  }
});

describe('a player that is up but has not loaded its title', () => {
  test('play → not-ready; stop still leaves', async () => {
    const calls: Calls = [];
    const ctx = ctxWith({calls, player: () => fakePlayer(calls, null)});
    expect(await runCommand(cmd('play'), ctx)).toMatchObject({ok: false, error: 'not-ready'});
    expect(await runCommand(cmd('stop'), ctx)).toEqual({ok: true});
    expect(calls).toEqual(['stop']);
  });
});

describe('with a film playing', () => {
  const setup = (n: Partial<NowState> = {}) => {
    const calls: Calls = [];
    const p = fakePlayer(calls, nowState(n));
    return {calls, ctx: ctxWith({calls, player: () => p})};
  };

  test('play / pause act only when they change something; toggle always', async () => {
    const {calls, ctx} = setup({paused: false});
    expect(await runCommand(cmd('play'), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('pause'), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('pause'), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('play'), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('toggle'), ctx)).toEqual({ok: true});
    expect(calls).toEqual(['pause', 'play', 'toggle']);
  });

  test('seek goes to the absolute second, inside the title', async () => {
    const {calls, ctx} = setup({duration: 6000});
    await runCommand(cmd('seek', {to: 1234.5}), ctx);
    await runCommand(cmd('seek', {to: 99999}), ctx);
    await runCommand(cmd('seek', {to: -5}), ctx);
    expect(calls).toEqual(['seekTo 1234.5', 'seekTo 5999', 'seekTo 0']);
  });

  test('skip is exact: the player’s seekTo at where it is + by (not the accelerating skip)', async () => {
    const {calls, ctx} = setup({position: 100});
    await runCommand(cmd('skip', {by: 10}), ctx);
    await runCommand(cmd('skip', {by: -30}), ctx);
    await runCommand(cmd('skip', {by: -3600}), ctx);
    expect(calls).toEqual(['seekTo 110', 'seekTo 70', 'seekTo 0']);
  });

  test('seek / skip on something that cannot be scrubbed', async () => {
    const {calls, ctx} = setup({canSeek: false});
    expect(await runCommand(cmd('seek', {to: 10}), ctx)).toEqual({ok: false, error: 'cannot-seek', message: MSG.cannotSeek});
    expect(await runCommand(cmd('skip', {by: 10}), ctx)).toMatchObject({ok: false, error: 'cannot-seek'});
    expect(calls).toEqual([]);
  });

  test('next: only when there is one', async () => {
    const a = setup({hasNext: false});
    expect(await runCommand(cmd('next'), a.ctx)).toEqual({ok: false, error: 'no-next', message: 'There is no next episode'});
    expect(a.calls).toEqual([]);
    const b = setup({hasNext: true, nextLabel: 'S1 E3'});
    expect(await runCommand(cmd('next'), b.ctx)).toEqual({ok: true});
    expect(b.calls).toEqual(['next']);
  });

  test('stop leaves the player', async () => {
    const {calls, ctx} = setup();
    expect(await runCommand(cmd('stop'), ctx)).toEqual({ok: true});
    expect(calls).toEqual(['stop']);
  });

  test('sub: a track, off (null or "off"), and one that is not there', async () => {
    const {calls, ctx} = setup();
    expect(await runCommand(cmd('sub', {id: 'English'}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('sub', {id: null}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('sub', {id: 'off'}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('sub', {id: 'Klingon'}), ctx)).toEqual({ok: false, error: 'no-such-track', message: MSG.noTrack});
    expect(await runCommand(cmd('sub', {}), ctx)).toMatchObject({ok: false, error: 'bad-command'});
    expect(calls).toEqual(['sub English', 'sub null', 'sub null', 'sub Klingon']);
  });

  test('audio: by the track’s id', async () => {
    const {calls, ctx} = setup({audios: [{id: '0', label: 'English', lang: 'en'}, {id: '1', label: 'Hebrew', lang: 'he'}], audio: '0'});
    expect(await runCommand(cmd('audio', {id: '1'}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('audio', {id: '7'}), ctx)).toMatchObject({ok: false, error: 'no-such-track'});
    expect(calls).toEqual(['audio 1', 'audio 7']);
  });

  test('sub_delay: needs a track on; a value, or a nudge from the current one', async () => {
    const off = setup({sub: null});
    expect(await runCommand(cmd('sub_delay', {by: 0.5}), off.ctx)).toEqual({ok: false, error: 'no-subtitles', message: 'Turn a subtitle track on first'});
    const on = setup({sub: 'English', subDelay: 1.5});
    await runCommand(cmd('sub_delay', {by: 0.5}), on.ctx);
    await runCommand(cmd('sub_delay', {value: -2}), on.ctx);
    await runCommand(cmd('sub_delay', {value: 9999}), on.ctx);
    expect(on.calls).toEqual(['delay 2', 'delay -2', 'delay 600']);
  });
});

describe('what needs no player', () => {
  test('play_item hands the args on, typed', async () => {
    const ctx = ctxWith();
    const item = {id: 'm1', title: 'Dune', showTitle: null, epTitle: null, season: null, episode: null, type: 'movie', imdbId: null, poster: null, duration: null};
    let got: unknown = null;
    ctx.playItem = async a => {
      got = a;
      return {ok: true, message: 'Opening'};
    };
    expect(await runCommand(cmd('play_item', {item, position: 61, restart: false, subLang: 'he', audioLang: null}), ctx)).toEqual({ok: true, message: 'Opening'});
    expect(got).toEqual({item, position: 61, restart: false, subLang: 'he', audioLang: null});
    expect(await runCommand(cmd('play_item', {}), ctx)).toMatchObject({ok: false, error: 'bad-command'});
  });

  test('keys: arrows, OK and Back are real presses; Home pops to the top', async () => {
    const ctx = ctxWith();
    for (const key of ['up', 'down', 'left', 'right', 'ok', 'back', 'home']) expect(await runCommand(cmd('key', {key}), ctx)).toEqual({ok: true});
    expect(ctx.calls).toEqual(['press up', 'press down', 'press left', 'press right', 'press ok', 'press back', 'home']);
    expect(await runCommand(cmd('key', {key: 'menu'}), ctx)).toMatchObject({ok: false, error: 'bad-command'});
  });

  test('keys without the native module: unsupported (Home still works)', async () => {
    const ctx = ctxWith({press: null});
    expect(await runCommand(cmd('key', {key: 'up'}), ctx)).toEqual({ok: false, error: 'unsupported', message: MSG.noKeys});
    expect(await runCommand(cmd('key', {key: 'home'}), ctx)).toEqual({ok: true});
  });

  test('keys while Aurora is in the background: said so, nothing pressed', async () => {
    const ctx = ctxWith({appState: () => 'background'});
    expect(await runCommand(cmd('key', {key: 'ok'}), ctx)).toEqual({ok: false, error: 'background', message: MSG.background});
    expect(ctx.calls).toEqual([]);
  });

  test('a press the activity did not take is failed', async () => {
    const ctx = ctxWith({press: async () => false});
    expect(await runCommand(cmd('key', {key: 'up'}), ctx)).toMatchObject({ok: false, error: 'failed'});
  });

  test('volume: a level (0..1), a step, mute', async () => {
    const ctx = ctxWith();
    expect(await runCommand(cmd('volume', {level: 0.3}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('volume', {level: 7}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('volume', {step: -1}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('mute', {on: true}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('mute', {on: false}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('volume', {}), ctx)).toMatchObject({ok: false, error: 'bad-command'});
    expect(ctx.calls).toEqual(['volume 0.3', 'volume 1', 'step -1', 'mute true', 'mute false']);
  });

  test('volume on a TV whose volume is fixed, or with no native module: unsupported', async () => {
    const fixed = ctxWith();
    fixed.volume!.get = async () => ({supported: false, level: null, muted: false, scope: 'system'});
    expect(await runCommand(cmd('volume', {step: 1}), fixed)).toEqual({ok: false, error: 'unsupported', message: MSG.noVolume});
    expect(await runCommand(cmd('mute', {on: true}), ctxWith({volume: null}))).toMatchObject({ok: false, error: 'unsupported'});
  });

  test('rename', async () => {
    const ctx = ctxWith();
    expect(await runCommand(cmd('rename', {name: '  Bedroom TV '}), ctx)).toEqual({ok: true});
    expect(await runCommand(cmd('rename', {name: '   '}), ctx)).toMatchObject({ok: false, error: 'bad-command'});
    expect(ctx.calls).toEqual(['rename Bedroom TV']);
  });

  test('a command nobody knows', async () => {
    expect(await runCommand(cmd('selfdestruct'), ctxWith())).toEqual({ok: false, error: 'bad-command', message: MSG.badCommand});
  });
});

describe('every command is answered, exactly once', () => {
  const run = async (ctx: HandlerCtx, msg: CommandMsg) => {
    const acks: Ack[] = [];
    const p = answer(msg, ctx, a => acks.push(a));
    return {acks, ack: await p};
  };

  test('ok, with the ref', async () => {
    const calls: Calls = [];
    const {acks} = await run(ctxWith({calls, player: () => fakePlayer(calls)}), cmd('toggle', {}, {ref: 'r9'}));
    expect(acks).toEqual([{type: 'remote_ack', ref: 'r9', ok: true}]);
  });

  test('refused, with its error and message', async () => {
    const {acks} = await run(ctxWith(), cmd('pause'));
    expect(acks).toEqual([{type: 'remote_ack', ref: 'r1', ok: false, error: 'nothing-playing', message: 'Nothing is playing on the TV'}]);
  });

  test('a handler that throws still answers: ok:false failed', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const calls: Calls = [];
    const p = fakePlayer(calls, nowState(), {
      toggle: () => {
        throw new Error('boom');
      },
    });
    const {acks} = await run(ctxWith({calls, player: () => p}), cmd('toggle'));
    expect(acks).toEqual([{type: 'remote_ack', ref: 'r1', ok: false, error: 'failed', message: MSG.failed}]);
    // a context that throws before anything runs, too
    const bad = ctxWith({player: () => { throw new Error('no'); }});
    expect((await run(bad, cmd('play'))).acks).toHaveLength(1);
    log.mockRestore();
  });

  test('a handler that never finishes is answered "timeout" — once, and not again when it does', async () => {
    jest.useFakeTimers();
    let release: (v: {ok: boolean}) => void = () => {};
    const ctx = ctxWith({playItem: () => new Promise(r => (release = r))});
    const acks: Ack[] = [];
    const item = {id: 'm1', title: 'x', showTitle: null, epTitle: null, season: null, episode: null, type: null, imdbId: null, poster: null, duration: null};
    const p = answer(cmd('play_item', {item}), ctx, a => acks.push(a));
    jest.advanceTimersByTime(ANSWER_MS - 1);
    await Promise.resolve();
    expect(acks).toHaveLength(0);
    jest.advanceTimersByTime(2);
    await p;
    expect(acks).toEqual([{type: 'remote_ack', ref: 'r1', ok: false, error: 'timeout', message: MSG.failed}]);
    release({ok: true});
    await Promise.resolve();
    await Promise.resolve();
    expect(acks).toHaveLength(1);
    jest.useRealTimers();
  });

  test('a send that throws does not throw out of answer', async () => {
    await expect(answer(cmd('pause'), ctxWith(), () => { throw new Error('socket gone'); })).resolves.toMatchObject({ok: false});
  });
});

describe('"Controlled from Elia’s iPhone"', () => {
  test('the words', () => {
    expect(whoFrom({label: 'iPhone', profileName: 'Elia'})).toBe("Elia's iPhone");
    expect(whoFrom({label: 'Android phone', profileName: null})).toBe('Android phone');
    expect(whoFrom(null)).toBe('your phone');
  });

  test('shown on the first command from a remote, once — not again after a reconnect says `first` again', async () => {
    const calls: Calls = [];
    const ctx = ctxWith({calls, player: () => fakePlayer(calls)});
    await answer(cmd('toggle', {}, {first: true}), ctx, () => {});
    await answer(cmd('toggle', {}, {first: false}), ctx, () => {});
    await answer(cmd('toggle', {}, {first: true}), ctx, () => {}); // the server forgot (a new socket)
    expect(ctx.toasts).toEqual(["📱 Controlled from Elia's iPhone"]);
    // another remote is another first
    await answer(cmd('toggle', {}, {first: true, from: {label: 'iPad', profileName: 'Dor'}}), ctx, () => {});
    expect(ctx.toasts).toEqual(["📱 Controlled from Elia's iPhone", "📱 Controlled from Dor's iPad"]);
  });

  test('two phones with the same words are two remotes when the server gives their ids; a reconnect of one is not', async () => {
    const ctx = ctxWith();
    await answer(cmd('toggle', {}, {first: true, from: {label: 'iPhone', profileName: 'Elia', id: 'phone-aaaaaaaa'}}), ctx, () => {});
    await answer(cmd('toggle', {}, {first: true, from: {label: 'iPhone', profileName: 'Elia', id: 'phone-bbbbbbbb'}}), ctx, () => {});
    await answer(cmd('toggle', {}, {first: true, from: {label: 'iPhone', profileName: 'Elia', id: 'phone-aaaaaaaa'}}), ctx, () => {}); // a reconnect
    expect(ctx.toasts).toEqual(["📱 Controlled from Elia's iPhone", "📱 Controlled from Elia's iPhone"]);
  });

  test('shown even when the first command itself fails', async () => {
    const ctx = ctxWith();
    await answer(cmd('pause', {}, {first: true, from: {label: 'iPhone'}}), ctx, () => {});
    expect(ctx.toasts).toEqual(['📱 Controlled from iPhone']);
  });

  test('not shown when `first` is not set', () => {
    const ctx = ctxWith();
    expect(noteFirst(cmd('pause'), ctx)).toBe(false);
    expect(ctx.toasts).toEqual([]);
  });
});

describe('key pacing', () => {
  test('presses run one after another, never closer than the gap — however they arrived', async () => {
    let t = 1000;
    const at: [string, number][] = [];
    const press = createPacer(
      async (k: string) => {
        at.push([k, t]);
        return true;
      },
      130,
      {now: () => t, sleep: async ms => void (t += ms)},
    );
    const all = await Promise.all([press('down'), press('down'), press('right')]);
    expect(all).toEqual([true, true, true]);
    expect(at).toEqual([['down', 1000], ['down', 1130], ['right', 1260]]);
    // a press long after the last one goes at once
    t = 5000;
    await press('up');
    expect(at[3]).toEqual(['up', 5000]);
  });

  test('a press that fails does not jam the ones after it', async () => {
    let n = 0;
    const press = createPacer(
      async () => {
        n += 1;
        if (n === 1) throw new Error('activity gone');
        return true;
      },
      0,
    );
    expect(await press('a')).toBe(false);
    expect(await press('b')).toBe(true);
  });
});
