// `"torrents": false` in config.json: the owner wants a library-only server.
// This is the one place that says what that means, so every entry point gives
// the same answer in the same words:
//
//   - no streaming client (WebTorrent) and no download engine (aria2) is ever
//     started,
//   - no source-provider lookup is made (Torrentio is asked only to feed the
//     two engines above),
//   - the routes that would have done any of it answer 403 with MESSAGE,
//   - the health watch and the healer report "off", never "broken".
//
// Unset or true is the default and changes nothing anywhere: every check in
// the code base is `if (!gate.enabled()) …` in front of what was already there.
//
// Read at call time, not captured at require time, so a test can flip
// config.TORRENTS for one case.
const config = require("../config");

const MESSAGE = "Torrents are switched off on this server.";

const enabled = () => config.TORRENTS !== false;

// An Error the callers that already catch (smart downloads, follows, the
// availability probe) swallow like any other "no sources" failure; `.code`
// lets a route tell it apart from a provider that did not answer.
const offError = () => Object.assign(new Error(MESSAGE), { code: "TORRENTS_OFF" });

// Express middleware for routes that exist only for torrents.
const requireOn = (req, res, next) => {
  if (enabled()) return next();
  res.status(403).json({ error: MESSAGE });
};

module.exports = { enabled, MESSAGE, offError, requireOn };
