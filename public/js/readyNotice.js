// "Tell me when it's ready": what is said when a download a person asked for
// lands. PURE — no imports (test/ready-notice.test.js runs it as it is).
// tv-native/src/readyNotice.ts is the TV's and the phone's side, word for word
// (test/ready-notice.test.js holds the two together). The sentences themselves
// come from the server (publicJob readyLine / langLine, media/downloads.js);
// the fallback is for a server from before them.
//
//   on    the person's "Tell me when it's ready" (prefs.readyNotice, on unless
//         switched off — it follows them to every device)
// → the toast's text, or null (nothing to say). What the language check found
// (langLine: "This copy doesn't say its language — report it again if it's
// wrong.") is said even with the switch off: it is about what they asked for.
export const READY_LABEL = "Tell me when it's ready";
export const READY_NOTE = "When something you asked for has downloaded, Aurora says so — on every device you use.";

export const readyText = (job, on) => {
  if (!job || job.status !== "done" || !job.mine || !job.libraryId || job.seenAt || job.smart) return null;
  const name = String(job.label || job.title || "").replace(/ — another version$/, "");
  const ready = job.readyLine || `“${name}” is ready to watch`;
  const lang = job.langLine || null;
  if (on !== false) return lang ? `${ready}. ${lang}` : ready;
  return lang ? `“${name}”: ${lang}` : null;
};
