// "Tell me when it's ready": what the TV and the phone say when a download a
// person asked for lands (SessionWiring.tsx). PURE — no imports. The website's
// side is public/js/readyNotice.js, word for word (test/ready-notice.test.js
// in the server's tests holds the two together). The sentences themselves come
// from the server (publicJob readyLine / langLine, media/downloads.js); the
// fallback is for a server from before them.
//
//   on   the person's "Tell me when it's ready" (personPrefs.ts readyNotice,
//        on unless switched off — it follows them to every device)
// → the toast's text, or null (nothing to say). What the language check found
// (langLine) is said even with the switch off: it is about what they asked for.
export const READY_LABEL = "Tell me when it's ready";
export const READY_NOTE = 'When something you asked for has downloaded, Aurora says so — on every device you use.';

export type ReadyJob = {
  status?: string;
  mine?: boolean;
  libraryId?: string | null;
  seenAt?: string | null;
  smart?: boolean;
  label?: string | null;
  title?: string | null;
  readyLine?: string | null;
  langLine?: string | null;
};

export const readyText = (job: ReadyJob | null | undefined, on: boolean): string | null => {
  if (!job || job.status !== 'done' || !job.mine || !job.libraryId || job.seenAt || job.smart) return null;
  const name = String(job.label || job.title || '').replace(/ — another version$/, '');
  const ready = job.readyLine || `“${name}” is ready to watch`;
  const lang = job.langLine || null;
  if (on !== false) return lang ? `${ready}. ${lang}` : ready;
  return lang ? `“${name}”: ${lang}` : null;
};
