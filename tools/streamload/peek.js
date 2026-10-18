// Start the instance over the film folder and print what it sees (a check of the rig).
const { startInstance, arg } = require("./lib");
(async () => {
  const t = Date.now();
  const srv = await startInstance({ movies: arg("movies"), tree: arg("tree", undefined) || undefined });
  console.log(`up in ${Date.now() - t} ms at ${srv.url}`);
  for (const f of srv.films) console.log(f.id, f.title, Math.round(f.duration), (f.size / 1e9).toFixed(2) + "G", f.container, f.video && f.video.codec, f.width + "x" + f.height, f.audio && f.audio.codec);
  await srv.stop();
})().catch((e) => { console.error(e); process.exit(1); });
