// Files from this device (public/js/localnames.js): the title under a file
// name's release junk, a show's season and episode, and which video each
// subtitle file belongs to — real-world names, Hebrew ones included.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "js", "localnames.js")).href);

test("film names: the title and the year under the release junk", async () => {
  const { parseName } = await load();
  const films = [
    ["The.Matrix.1999.1080p.BluRay.x264-YIFY.mp4", "The Matrix", 1999],
    ["Inception (2010) [1080p] [YTS.MX].mp4", "Inception", 2010],
    ["Spider-Man.No.Way.Home.2021.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-EVO.mkv", "Spider-Man No Way Home", 2021],
    ["2001.A.Space.Odyssey.1968.REMASTERED.1080p.mkv", "2001 A Space Odyssey", 1968],
    ["1917.2019.1080p.mkv", "1917", 2019],
    ["Blade Runner 2049 (2017).mkv", "Blade Runner 2049", 2017],
    ["Avatar.The.Way.of.Water.2022.HDR.2160p.WEB.H265-CMRG[TGx].mkv", "Avatar The Way of Water", 2022],
    ["Charlotte's.Web.2006.1080p.mkv", "Charlotte's Web", 2006],
    ["Johnny.English.2003.720p.mkv", "Johnny English", 2003],
    ["Movie.2019.Directors.Cut.1080p.mkv", "Movie", 2019],
    ["Holiday.Film.2024.1080p.BluRay.x265-RARBG.mp4", "Holiday Film", 2024],
    ["www.Torrenting.com - Dune.Part.Two.2024.1080p.mkv", "Dune Part Two", 2024],
    ["Oppenheimer.2023.IMAX.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv", "Oppenheimer", 2023],
    ["the.godfather.1972.720p.bluray.x264.mkv", "The Godfather", 1972],
    ["Robot 2.0.mkv", "Robot 2.0", null],
    ["movie.mp4", "Movie", null],
    ["VID_20240101_123456.mp4", "VID 20240101 123456", null],
    ["Am.I.Ok.2022.WEBRip.x264-ION10.mp4", "Am I Ok", 2022],
    ["Parasite (2019) [Korean] 1080p.mkv", "Parasite", 2019],
    // Hebrew
    ["גבעת חלפון אינה עונה 1976.mp4", "גבעת חלפון אינה עונה", 1976],
    ["אסקימו לימון.1978.720p.mkv", "אסקימו לימון", 1978],
    ["הסרט_שלי.mp4", "הסרט שלי", null],
  ];
  for (const [name, title, year] of films) {
    const p = parseName(name);
    assert.equal(p.kind, "film", `${name} is a film: ${JSON.stringify(p)}`);
    assert.equal(p.title, title, name);
    assert.equal(p.year, year, name);
  }
});

test("episode names: the show, the season and the episode — by code, by words, by folder", async () => {
  const { parseName, episodeCode } = await load();
  const eps = [
    ["The.Office.US.S01E01.720p.WEB-DL.x264-GRP.mp4", "The Office US", 1, 1, null],
    ["The Office (US) S02E01.mkv", "The Office US", 2, 1, null],
    ["game.of.thrones.s08e03.720p.web.h264-memento.mkv", "Game of Thrones", 8, 3, null],
    ["Breaking Bad - 1x02 - Cat's in the Bag.mkv", "Breaking Bad", 1, 2, "Cat's in the Bag"],
    ["Friends - Season 1 - Episode 5.avi", "Friends", 1, 5, null],
    ["The.Mandalorian.S02E08.Chapter.16.The.Rescue.2160p.DSNP.WEB-DL.mkv", "The Mandalorian", 2, 8, "Chapter 16 The Rescue"],
    ["Doctor.Who.2005.S01E01.Rose.mkv", "Doctor Who", 1, 1, "Rose"],
    ["Fauda.S03E01.HEBREW.1080p.NF.WEB-DL.mkv", "Fauda", 3, 1, null],
    ["[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv", "Frieren", null, 5, null],
    ["Lost Episode 12.mp4", "Lost", null, 12, null],
    // Hebrew
    ["המשרד.S01E02.720p.mkv", "המשרד", 1, 2, null],
    ["שטיסל עונה 2 פרק 5.mp4", "שטיסל", 2, 5, null],
    ["עבודה ערבית פרק 3.mkv", "עבודה ערבית", null, 3, null],
  ];
  for (const [name, show, season, episode, epTitle] of eps) {
    const p = parseName(name);
    assert.equal(p.kind, "episode", `${name}: ${JSON.stringify(p)}`);
    assert.equal(p.show, show, name);
    assert.equal(p.season, season, name);
    assert.equal(p.episode, episode, name);
    assert.equal(p.epTitle, epTitle, name);
  }
  const two = parseName("Shtisel.S01E01E02.mkv");
  assert.equal(two.episode2, 2);
  assert.equal(episodeCode(two), "S1 E1–E2");
  assert.equal(episodeCode(parseName("Frieren - 05.mkv")), "E5");
  // the season and the show from the folders
  const f = parseName("03 - Pilot.mkv", "drop:x1/Lost/Season 1");
  assert.deepEqual([f.kind, f.show, f.season, f.episode, f.epTitle], ["episode", "Lost", 1, 3, "Pilot"]);
  const g = parseName("Episode 4.mkv", "pick:a/Shtisel/עונה 2");
  assert.deepEqual([g.show, g.season, g.episode], ["Shtisel", 2, 4]);
  // not episodes
  for (const name of ["1917 - 2019.mkv", "Film.1920x1080.mkv", "Movie - 1080p.mkv"]) assert.equal(parseName(name).kind, "film", name);
});

test("subtitle names: the language, forced / SDH, the copy number — and what is left to match", async () => {
  const { subInfo, subLabel } = await load();
  const cases = [
    ["Film.he.srt", ["Film"], "he", false, false, null],
    ["Film.Hebrew.srt", ["Film"], "he", false, false, null],
    ["Film.en.forced.srt", ["Film"], "en", true, false, null],
    ["Film.2.srt", ["Film.2", "Film"], null, false, false, 2],
    ["Episode 2.srt", ["Episode 2"], null, false, false, null],
    ["The Office - 1x02 - Hebrew.srt", ["The Office - 1x02"], "he", false, false, null],
    ["Film_heb.srt", ["Film"], "he", false, false, null],
    ["Film (English) SDH.srt", ["Film"], "en", false, true, null],
    ["Film.eng.hi.srt", ["Film"], "en", false, true, null],
    ["סרט עברית.srt", ["סרט"], "he", false, false, null],
    ["Film.rus.ass", ["Film"], "ru", false, false, null],
    ["Film.ara.srt", ["Film"], "ar", false, false, null],
    ["Film.pt-BR.srt", ["Film"], "pt", false, false, null],
    ["Film.zh-Hans.srt", ["Film"], "zh", false, false, null],
    ["Heather.srt", ["Heather"], null, false, false, null],
    ["It.2017.srt", ["It.2017"], null, false, false, null],
  ];
  for (const [name, stems, lang, forced, sdh, n] of cases) {
    const i = subInfo(name);
    assert.deepEqual([i.stems, i.lang, i.forced, i.sdh, i.n], [stems, lang, forced, sdh, n], name);
  }
  assert.equal(subLabel(subInfo("Film.en.forced.srt")), "English (forced)");
  assert.equal(subLabel(subInfo("Film.heb.sdh.srt")), "Hebrew SDH");
  assert.equal(subLabel(subInfo("Film.2.srt"), "he"), "Hebrew 2");
  assert.equal(subLabel(subInfo("random.srt")), "Subtitles");
});

test("pairing: same name, flags off; the start of the name; the episode code; the folder; the only video", async () => {
  const { matchSubs } = await load();
  const V = (key, name, dir = "pick:1") => ({ key, name, dir });
  const S = (key, name, dir = "pick:1") => ({ key, name, dir });
  const videos = [
    V("e1", "The.Office.US.S01E01.720p.WEB-DL.x264-GRP.mp4"),
    V("e2", "The.Office.US.S01E02.720p.WEB-DL.x264-GRP.mp4"),
    V("film", "Holiday.Film.2024.1080p.BluRay.x265-RARBG.mp4"),
  ];
  const subs = [
    S("s1", "The.Office.US.S01E01.720p.WEB-DL.x264-GRP.he.srt"),
    S("s2", "The Office - 1x02 - Hebrew.srt"),
    S("s3", "Holiday.Film.2024.1080p.BluRay.x265-RARBG.en.forced.srt"),
    S("s4", "subs-from-a-friend.srt"),
    S("s5", "Holiday Film 2024.srt", "pick:2"),
    S("s6", "office e01 heb.srt", "pick:2"),
    S("s7", "Holiday.Film.2024.1080p.BluRay.x265-RARBG.2.srt"),
    S("s8", "holiday film.Hebrew.srt", "pick:3"),
    S("s9", "Holiday.Film.2024.720p.WEB.heb.srt", "pick:3"),
  ];
  const m = matchSubs(videos, subs);
  const got = Object.fromEntries([...m].map(([k, v]) => [k, `${v.video}/${v.how}`]));
  assert.deepEqual(got, {
    s1: "e1/name", s2: "e2/episode", s3: "film/name", s5: "film/name", s6: "e1/episode", s7: "film/name", s8: "film/name", s9: "film/title",
  });
  assert.ok(!m.has("s4"), "a name that says nothing, with three videos to choose from, waits");

  // two shows with the same episode code: the show's name decides
  const two = matchSubs([V("a", "Shtisel.S01E03.mkv"), V("b", "Fauda.S01E03.mkv")], [S("x", "fauda 1x03 heb.srt", "z"), S("y", "S01E03.srt", "z")]);
  assert.equal(two.get("x").video, "b");
  assert.ok(!two.has("y"), "the code alone cannot tell two shows apart");

  // a lone subtitle beside a lone video, in a folder (and in its Subs folder)
  const dir = matchSubs(
    [V("m", "Some.Movie.2020.mkv", "drop:1/Some Movie"), V("o", "Other.mkv", "drop:1/Other")],
    [S("a", "English.srt", "drop:1/Some Movie"), S("b", "Hebrew.srt", "drop:1/Some Movie/Subs"), S("c", "x.srt", "drop:1/Third")],
  );
  assert.equal(dir.get("a").video, "m");
  assert.equal(dir.get("a").how, "folder");
  assert.equal(dir.get("b").video, "m");
  assert.ok(!dir.has("c"));

  // one video picked with a subtitle of any name (the first version's way)
  const one = matchSubs([V("v", "VID_0001.mp4", "pick:9")], [S("s", "whatever.srt", "pick:9")]);
  assert.equal(one.get("s").how, "folder");
  // a subtitle added later, with only one video in the list
  const only = matchSubs([V("v", "VID_0001.mp4", "pick:9")], [S("s", "whatever.srt", "pick:10")]);
  assert.equal(only.get("s").how, "only");

  // Hebrew names
  const he = matchSubs([V("a", "שטיסל עונה 2 פרק 5.mp4"), V("b", "שטיסל עונה 2 פרק 6.mp4")], [S("x", "שטיסל.S02E06.עברית.srt", "q"), S("y", "שטיסל עונה 2 פרק 5.srt", "q")]);
  assert.equal(he.get("x").video, "b");
  assert.equal(he.get("y").video, "a");
});
