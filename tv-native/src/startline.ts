// A play's start-up, step by step, from the press on Play to the first frame
// — the website's public/js/startline.js, the same steps and names, so the
// admin's App health → Slow starts and a problem report read both apps alike.
// On the TV the press is the player's mount (Detail pushes the player in the
// same frame); the steps are what the player can see of ExoPlayer:
//   item     the title and the profile's progress are known (meta)
//   decide   the way it will play is chosen (armed)
//   claim    an encode's claim was answered (it is awaited before the source)
//   ask      the source was handed to ExoPlayer
//   byte     ExoPlayer has opened it (onLoad: its first bytes are parsed)
//   frame    the first frame (onReadyForDisplay)
export const STEPS = ['open', 'item', 'history', 'probe', 'mount', 'decide', 'claim', 'ask', 'byte', 'frame'] as const;
export const SLOW_START_MS = 6000;

export type Startup = {total: number; slow: string | null; slowMs: number; path: string | null; steps: [string, number][]};

export const startupOf = (press: number, at: Partial<Record<string, number>>, path: string | null = null): Startup | null => {
  if (!Number.isFinite(press)) return null;
  const steps: [string, number][] = [];
  let prev = 0;
  let slow: string | null = null;
  let slowMs = -1;
  for (const name of STEPS) {
    const t = at[name];
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    const ms = Math.max(prev, Math.max(0, Math.round(t - press)));
    if (ms - prev > slowMs) {
      slowMs = ms - prev;
      slow = name;
    }
    steps.push([name, ms]);
    prev = ms;
  }
  if (!steps.length) return null;
  return {total: steps[steps.length - 1][1], slow, slowMs: Math.max(0, slowMs), path, steps};
};

export const stepsText = (s: Startup | null) => (s ? s.steps.map(([n, ms]) => `${n}:${ms}`).join(',') : '');

// Where a start that failed before its first frame falls back to: the resume
// point it was heading for (a direct play seeks there only once loaded), else
// where it got to, else where its stream began. (A direct play's stream
// offset is 0: falling back "at the stream offset" restarted a resume at 0:00.)
export const fallbackFrom = ({resumeAt, cur, offset}: {resumeAt: number; cur: number; offset: number}) =>
  resumeAt > 0 ? resumeAt : Math.max(offset || 0, cur > 5 ? cur : 0);
