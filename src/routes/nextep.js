// GET /api/next-episode — which episode comes after the one that is playing.
// One rule for every client (media/nextep.js has it, and why).
//   ?id=<library episode id>
//   ?imdbId=tt…&season=2&episode=4[&title=…&year=…]   (a streamed episode)
// → { next: null
//          | { kind: "library", id, showId, season, episode, title }
//          | { kind: "stream", imdbId, season, episode, title, released },
//     why }
// `library`: on disk — it plays at once and may start by itself.
// `stream`: not on disk — offer it, never start it by itself.
// Never an error status for "nothing next": a player asks this in passing.
const express = require("express");
const nextep = require("../media/nextep");

const router = express.Router();

router.get("/api/next-episode", async (req, res) => {
  const q = req.query || {};
  try {
    const r = await nextep.nextFor({
      id: q.id ? String(q.id).slice(0, 300) : null,
      imdbId: q.imdbId,
      season: q.season,
      episode: q.episode,
      title: q.title,
      year: q.year,
    });
    res.json(r);
  } catch {
    res.json({ next: null, why: "error" });
  }
});

module.exports = router;
