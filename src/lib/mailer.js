// Email for password resets (auth-round, 2026-10-31). BUILT AND SWITCHED OFF:
// nothing here sends a thing until the owner configures a mail account and
// turns it on. docs/auth-round.md section 5 lists what that takes.
//
// config.json:
//   "publicUrl": "https://nufurora.com",           where the link in the email points
//                                                   (never taken from a request's Host)
//   "passwordReset": { "email": {
//       "enabled": true,
//       "from": "Aurora <no-reply@nufurora.com>",
//       "provider": "smtp",                        or "resend"
//       "smtp": { "host": "smtp.example.com", "port": 465, "user": "no-reply@nufurora.com" }
//   } }
// .env (secrets never go in config.json):
//   AURORA_SMTP_PASSWORD=…        for "smtp"
//   AURORA_MAIL_API_KEY=…         for "resend" (https://resend.com, an HTTP API)
//
// SMTP is spoken here directly (no dependency): implicit TLS on 465, or
// STARTTLS on any other port. A server that offers neither is refused — a
// password-reset link never travels in clear text.
"use strict";
const net = require("net");
const tls = require("tls");
const os = require("os");
const config = require("../config");

const settings = () => {
  const pr = (config.PASSWORD_RESET && config.PASSWORD_RESET.email) || {};
  return {
    enabled: pr.enabled === true,
    from: typeof pr.from === "string" ? pr.from : null,
    provider: pr.provider === "resend" ? "resend" : "smtp",
    smtp: pr.smtp && typeof pr.smtp === "object" ? pr.smtp : {},
    publicUrl: typeof config.PUBLIC_URL === "string" ? config.PUBLIC_URL.replace(/\/+$/, "") : null,
    smtpPassword: process.env.AURORA_SMTP_PASSWORD || null,
    apiKey: process.env.AURORA_MAIL_API_KEY || null,
  };
};

// What is missing before email can be switched on ([] = ready).
const missing = (s = settings()) => {
  const out = [];
  if (!s.enabled) out.push('passwordReset.email.enabled is not true');
  if (!s.publicUrl || !/^https:\/\//.test(s.publicUrl)) out.push('publicUrl (https://…) is not set');
  if (!s.from) out.push('passwordReset.email.from is not set');
  if (s.provider === "smtp") {
    if (!s.smtp.host) out.push('passwordReset.email.smtp.host is not set');
    if (!s.smtp.user) out.push('passwordReset.email.smtp.user is not set');
    if (!s.smtpPassword) out.push('AURORA_SMTP_PASSWORD is not in .env');
  } else if (!s.apiKey) out.push('AURORA_MAIL_API_KEY is not in .env');
  return out;
};
const ready = () => missing().length === 0;

const addrOf = (from) => {
  const m = /<([^>]+)>/.exec(String(from || ""));
  return (m ? m[1] : String(from || "")).trim();
};
// RFC 5322 message; the body is plain text, lines dot-stuffed by the sender.
const message = ({ from, to, subject, text }) => {
  const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${addrOf(from).split("@")[1] || "aurora"}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf-8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
};

// One SMTP conversation. `connect` (tests): how to open the socket; `insecureOk`
// (tests only, never from config): allow a server with no TLS.
const sendSmtp = (s, msg, { connect = null, insecureOk = false, timeoutMs = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    const host = s.smtp.host;
    const port = Number(s.smtp.port) || 465;
    let sock = connect ? connect() : port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let secure = !connect && port === 465;
    let buf = "";
    const replies = []; // complete replies not asked for yet
    let waiter = null;
    const timer = setTimeout(() => fail(new Error("the mail server did not answer in time")), timeoutMs);
    const fail = (e) => { clearTimeout(timer); try { sock.destroy(); } catch {} reject(e); };
    const onData = (d) => {
      buf += d.toString("utf-8");
      // a reply is complete at a line "NNN text" (not "NNN-text")
      for (;;) {
        const lines = buf.split("\r\n");
        const end = lines.findIndex((l, i) => i < lines.length - 1 && /^\d{3} /.test(l));
        if (end < 0) return;
        replies.push(lines.slice(0, end + 1));
        buf = lines.slice(end + 1).join("\r\n");
        if (waiter) { const w = waiter; waiter = null; w(replies.shift()); }
      }
    };
    const attach = (x) => { x.on("data", onData); x.on("error", fail); };
    attach(sock);
    const read = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => { waiter = r; }));
    const cmd = async (line, ok) => {
      if (line != null) sock.write(line + "\r\n");
      const reply = await read();
      const code = Number(reply[reply.length - 1].slice(0, 3));
      if (!ok.includes(code)) throw new Error(`the mail server refused: ${reply[reply.length - 1].slice(0, 120)}`);
      return reply;
    };
    (async () => {
      await cmd(null, [220]);
      const me = os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "aurora";
      let ehlo = await cmd(`EHLO ${me}`, [250]);
      if (!secure) {
        if (!ehlo.some((l) => /STARTTLS/i.test(l))) {
          if (!insecureOk) throw new Error("the mail server offers no encryption (STARTTLS) — not sending");
        } else {
          await cmd("STARTTLS", [220]);
          sock.removeListener("data", onData);
          sock = tls.connect({ socket: sock, servername: host });
          attach(sock);
          await new Promise((r, j) => { sock.once("secureConnect", r); sock.once("error", j); });
          secure = true;
          ehlo = await cmd(`EHLO ${me}`, [250]);
        }
      }
      const auth = Buffer.from(`\u0000${s.smtp.user}\u0000${s.smtpPassword || ""}`, "utf-8").toString("base64");
      await cmd(`AUTH PLAIN ${auth}`, [235]);
      await cmd(`MAIL FROM:<${addrOf(s.from)}>`, [250]);
      await cmd(`RCPT TO:<${msg.to}>`, [250, 251]);
      await cmd("DATA", [354]);
      const body = message({ from: s.from, ...msg }).replace(/\r\n\./g, "\r\n..");
      await cmd(`${body}\r\n.`, [250]);
      try { sock.write("QUIT\r\n"); } catch {}
      clearTimeout(timer);
      try { sock.end(); } catch {}
      resolve({ ok: true });
    })().catch(fail);
  });

const sendResend = async (s, msg) => {
  const r = await require("./upstream").fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: s.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    timeoutMs: 10000,
    breaker: false,
  });
  if (!r.ok) throw new Error(`the mail service refused (HTTP ${r.status})`);
  return { ok: true };
};

// The reset email. Fire-and-forget from the route's point of view: the answer
// to the person never depends on it (no enumeration, no waiting on a mail server).
const sendReset = async ({ to, name, token }) => {
  const s = settings();
  if (!ready()) return { ok: false, off: true };
  const link = `${s.publicUrl}/#/reset/${encodeURIComponent(token)}`;
  const admin = config.ADMIN_NAME || "the admin";
  const text = [
    `Hi ${name || "there"},`,
    "",
    "Someone asked to reset the password of your Aurora profile. If it was you, open this link within 30 minutes and choose a new password:",
    "",
    link,
    "",
    `If it wasn't you, ignore this email. Your password stays as it is. You can tell ${admin} about it.`,
    "",
    "Aurora",
  ].join("\r\n");
  const msg = { to, subject: "Reset your Aurora password", text };
  return s.provider === "resend" ? sendResend(s, msg) : sendSmtp(s, msg);
};

module.exports = { settings, missing, ready, sendReset, _internals: { sendSmtp, message } };
