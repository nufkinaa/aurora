// How one row of "My downloads" reads — its status line, its size, when it
// finished — shared by the TV's page (screens/Downloads.tsx) and the phone's
// (phone/screens/Downloads.tsx). Moved out of screens/Downloads.tsx as it was.
import type {MyDownload} from './api';
import {replaceJobLine} from './replaceLogic';

export const ACTIVE = ['approved', 'downloading'];
export const fmtBytes = (b?: number) => {
  if (!b) return '';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};
export const when = (iso?: string | null) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  return new Date(t).toLocaleDateString();
};
export const eta = (j: MyDownload) => {
  // the server's own figure first (its speed is smoothed and this file's share)
  const known = typeof j.etaSec === 'number' && Number.isFinite(j.etaSec) ? j.etaSec : null;
  if (known == null && (!j.sizeBytes || !j.downloadSpeed)) return '';
  const s = known != null ? Math.round(known) : Math.round(((j.sizeBytes || 0) * (1 - (j.progress || 0))) / (j.downloadSpeed || 1));
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};
// A row that was to replace a copy says the copy is safe.
const stays = (j: MyDownload) => (j.replaces ? ' — your copy stays as it was' : '');
export const statusLine = (j: MyDownload) => {
  // "Get another version": finished, held back while somebody plays the old copy
  const waiting = replaceJobLine(j);
  if (waiting) return waiting;
  switch (j.status) {
    case 'done':
      return j.libraryId ? `Ready · ${when(j.doneAt)}` : 'Finished — indexing…';
    case 'downloading': {
      if (j.phase === 'copying') return `Copying into the library · ${Math.round((j.copyProgress || 0) * 100)}%`;
      const base =
        j.phase === 'finding' || j.phase === 'starting'
          ? 'Finding peers…'
          : j.heldBack
          ? `${Math.round((j.progress || 0) * 100)}%` // held back a moment: no trickle speed, no "23 h left"
          : [`${Math.round((j.progress || 0) * 100)}%`, j.downloadSpeed ? `${(j.downloadSpeed / 1e6).toFixed(1)} MB/s` : '', eta(j)]
              .filter(Boolean)
              .join(' · ');
      // what the server says is going on ("No one is sharing this copy right now — trying another")
      return j.note ? `${base} · ${j.note}` : base;
    }
    case 'approved':
      // waiting to try again: no copy could be found a moment ago
      if (j.note && j.retryAt) return j.note;
      if (j.accountLimit) return `Queued — starts when one of ${j.mine ? 'your' : 'their'} ${j.accountLimit} running downloads finishes`;
      return 'Queued — starts when a slot frees up';
    case 'pending':
      return j.holdReason ? `Waiting for approval — ${j.holdReason}` : 'Waiting for approval';
    case 'declined':
      return `Declined by the admin${stays(j)}`;
    case 'canceled':
      // (who did it: only the person who asked or the admin can)
      return `${j.canceledBy === 'admin' ? 'Cancelled by the admin' : j.canceledBy === 'self' ? 'Cancelled by you' : 'Cancelled'}${stays(j)}`;
    case 'error':
      return j.replaces ? `Failed, your copy stays as it was — ${j.error || 'unknown error'}` : `Failed — ${j.error || 'unknown error'}`;
    default:
      return j.status;
  }
};
