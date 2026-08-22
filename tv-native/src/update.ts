// Lightweight self-update check. The server can publish a `tv-version.json`
// next to the downloadable APK ({ "versionName": "2.1", "notes": "..." }); if
// it advertises a version newer than this build, Home shows a banner pointing
// at the download page. Purely informational — no auto-download. No-ops
// (returns null) when the file is absent, so it's safe before first publish.
import {getBaseUrl} from './api';

// Keep in lockstep with android/app/build.gradle versionName on each release.
// (Was '2.3' while gradle said 4.7 — the drift meant a published
// tv-version.json would have compared against the wrong number.)
export const APP_VERSION = '4.8';

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

export type UpdateInfo = {version: string; url: string; notes?: string};

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const base = getBaseUrl();
  if (!base) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000); // don't let a slow check linger
  try {
    // Cache-busted: the device's HTTP cache (and any CDN in front of the
    // server) happily serves a stale copy under a long max-age — measured on
    // the Streamer, the banner sat on the previous version until the cache
    // expired. A unique query string makes every check hit the origin.
    const res = await fetch(`${base}/tv-version.json?t=${Date.now()}`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as {versionName?: string; notes?: string};
    if (j.versionName && cmp(APP_VERSION, j.versionName) < 0) {
      return {version: j.versionName, url: `${base}/download`, notes: j.notes};
    }
  } catch {
    clearTimeout(t);
  }
  return null;
}
