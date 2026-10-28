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
  if (!j.sizeBytes || !j.downloadSpeed) return '';
  const s = Math.round((j.sizeBytes * (1 - (j.progress || 0))) / j.downloadSpeed);
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};
export const statusLine = (j: MyDownload) => {
  // "Get another version": finished, held back while somebody plays the old copy
  const waiting = replaceJobLine(j);
  if (waiting) return waiting;
  switch (j.status) {
    case 'done':
      return j.libraryId ? `Ready · ${when(j.doneAt)}` : 'Finished — indexing…';
    case 'downloading':
      return j.phase === 'copying'
        ? `Copying into the library · ${Math.round((j.copyProgress || 0) * 100)}%`
        : j.phase === 'finding' || j.phase === 'starting'
        ? 'Finding peers…'
        : [`${Math.round((j.progress || 0) * 100)}%`, j.downloadSpeed ? `${(j.downloadSpeed / 1e6).toFixed(1)} MB/s` : '', eta(j)]
            .filter(Boolean)
            .join(' · ');
    case 'approved':
      if (j.accountLimit) return `Queued — starts when one of ${j.mine ? 'your' : 'their'} ${j.accountLimit} running downloads finishes`;
      return 'Queued — starts when a slot frees up';
    case 'pending':
      return j.holdReason ? `Waiting for approval — ${j.holdReason}` : 'Waiting for approval';
    case 'declined':
      return 'Declined by the admin';
    case 'canceled':
      return 'Canceled';
    case 'error':
      return `Failed — ${j.error || 'unknown error'}`;
    default:
      return j.status;
  }
};
