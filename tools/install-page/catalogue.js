// The invented catalogue behind the /install page's screenshots: films and
// series with made-up names, synopses and people, in the shape Cinemeta
// answers in (the same module shape as tools/mobile-perf/catalogue.js, so
// that harness's way of answering the server's lookups works with it).
// Nothing here is a real title. Deterministic.
"use strict";

const FILMS = [
  ["The Lantern Keeper", "Every light waits for someone.", ["Drama", "Mystery"], "On a storm-beaten island, the last lighthouse keeper finds a logbook that predicts tomorrow's shipwrecks — and one of them is her own."],
  ["Northbound", "", ["Adventure", "Drama"], "Two estranged brothers drive their father's old truck to the top of the map, carrying his ashes and every argument they never finished."],
  ["Salt & Ember", "", ["Romance", "Drama"], "A pastry chef and a glassblower share a crumbling seaside workshop for one summer, and neither of them wants the lease to end."],
  ["The Quiet Meridian", "", ["Sci-Fi", "Thriller"], "When every clock on Earth stops for exactly one minute, a navigator on a research ship is the only person who remembers what happened in it."],
  ["Iron Coast", "", ["Action", "Thriller"], "A retired harbour pilot is pulled back for one last night run through a strait no one else will sail."],
  ["Paper Moons", "", ["Comedy", "Family"], "A small-town printer accidentally publishes a fake moon landing in the local paper — and the whole town decides to believe it."],
  ["Kestrel", "", ["Thriller", "Crime"], "A wildlife photographer's long lens catches something on a cliff that a very careful man wanted no one to see."],
  ["The Long Signal", "", ["Sci-Fi", "Drama"], "A radio astronomer receives a message that repeats her mother's voice, recorded forty years before she was born."],
  ["Wildfire Season", "", ["Drama", "Action"], "One summer, one ridge, and a crew of smokejumpers who have to decide what is worth saving."],
  ["Copper Sky", "", ["Adventure", "Sci-Fi"], "The first family to farm on a terraformed moon discovers the soil has opinions."],
  ["The Last Ferry", "", ["Drama", "Romance"], "Strangers on the final crossing of a ferry line that closes at midnight tell each other the truth, because none of them will meet again."],
  ["Hollow Pines", "", ["Horror", "Mystery"], "A forest ranger counts the trees in her valley every year. This year there is one more."],
  ["The Winter Archive", "", ["Mystery", "Drama"], "A librarian cataloguing a dead novelist's papers finds the drafts of a book about her own life."],
  ["Silver Line", "", ["Thriller", "Action"], "A night train, a stolen ledger and seven passengers who all bought the same seat."],
  ["Velvet Hour", "", ["Romance", "Comedy"], "A jazz pianist with stage fright agrees to play one secret concert a week for an audience of one."],
  ["Ashfall", "", ["Action", "Adventure"], "When the mountain wakes, a geologist and her estranged daughter have six hours to reach the last helicopter out."],
  ["The Orchard Thief", "", ["Comedy", "Crime"], "Someone is stealing the prize apples of a sleepy valley, and the retired detective on the case has never been happier."],
  ["Starlight Motel", "", ["Drama", "Comedy"], "Guests of a desert motel at the end of Route 9 have one thing in common: they all checked in to leave something behind."],
  ["Cold Water Rising", "", ["Thriller", "Drama"], "A diver searching a flooded village for a lost bell finds the town still keeping its secrets underwater."],
  ["Sundown Express", "", ["Action", "Comedy"], "A courier with a broken speedometer has until sunset to cross three borders with a cake that must not melt."],
  ["Little Comet", "", ["Animation", "Family"], "A small comet who is afraid of the dark sets out to find the brightest star in the sky — and ends up lighting the way for everyone else."],
  ["Ember Road", "", ["Drama", "Crime"], "A mechanic in a town of one road learns that every car she fixes has passed through the same night."],
  ["Moth & Flame", "", ["Romance", "Fantasy"], "A lamplighter falls for a girl who only appears in the moment a flame is lit."],
  ["Distant Shores", "", ["Adventure", "Documentary"], "Four sailors attempt the oldest trade route on the ocean in a boat built from memory."],
  ["The Cartographer", "", ["Fantasy", "Adventure"], "A mapmaker discovers that whatever she draws becomes real — and someone has been erasing her maps."],
  ["Meridian Park", "", ["Comedy", "Drama"], "The residents of a city park — the chess players, the dog walkers, the pigeon lady — band together to stop it becoming a parking lot."],
  ["Glass Mountain", "", ["Drama", "Adventure"], "A climber returns to the peak that took her partner, guided by the notes he left in every camp."],
  ["Harvest Moon", "", ["Family", "Drama"], "Three generations of a farming family gather for one last harvest before the land is sold."],
  ["Night Orchard", "", ["Mystery", "Horror"], "The trees in the old orchard bloom only at night, and the children of the village have started to follow them."],
  ["Blue Hour", "", ["Drama", "Romance"], "Two night-shift nurses share twenty minutes of dawn on a hospital roof every morning for a year."],
  ["The Gilded Compass", "", ["Adventure", "Family"], "Twins inherit a compass that points not north but to whatever its holder has lost."],
  ["Low Tide Kings", "", ["Comedy", "Crime"], "Three retired fishermen plan the heist of their lives: the town's sandcastle trophy."],
  ["Echo Valley", "", ["Thriller", "Mystery"], "In a valley where every sound returns, a sheriff hears a confession that no one has spoken yet."],
  ["A Field of Static", "", ["Sci-Fi", "Horror"], "A farmer's television begins broadcasting the view from inside the barn."],
  ["Saltwater Kids", "", ["Family", "Adventure"], "A summer of rock pools, a stolen rowboat and a map to an island that only appears at low tide."],
  ["The Beacon", "", ["Thriller", "Sci-Fi"], "A rescue crew answers a distress call from a ship that sank a century ago."],
  ["Iron Meadow", "", ["Drama", "Action"], "A champion ploughing horse and the girl who refuses to let him be sold."],
  ["The Midnight Atlas", "", ["Fantasy", "Mystery"], "Every night at twelve, the streets of an old city rearrange themselves — and one cab driver can see how."],
  ["Paper Lanterns", "", ["Romance", "Drama"], "Over one festival night, a lantern maker and a stranger send up a hundred wishes and keep one."],
  ["Wild Atlas", "", ["Documentary", "Adventure"], "A year-long journey along the great migration routes of the north, told by the animals that walk them."],
  ["The Summit Hotel", "", ["Comedy", "Mystery"], "Snowed in at a mountain hotel, eleven guests discover they have all been invited by the same person — who is not there."],
  ["Silent Tide", "", ["Thriller", "Drama"], "A coastguard officer has one night to find the boat that keeps appearing on her radar and nowhere else."],
];

const SERIES = [
  ["Glass Harbour", "", ["Drama", "Crime"], "In a harbour town where everyone knows everyone, a detective returns home to investigate the one crime no one will talk about."],
  ["Halcyon Drift", "", ["Sci-Fi", "Drama"], "The crew of a slow generation ship are the grandchildren of the people who launched it — and the first to wonder where it is going."],
  ["After the Tide", "", ["Mystery", "Drama"], "When a storm surge uncovers a buried village, a family of archaeologists finds their own name on the oldest gravestone."],
  ["The Atlas Files", "", ["Thriller", "Crime"], "An analyst at a map agency discovers that the empty spaces on official maps are not empty."],
  ["Fault Lines", "", ["Drama", "Thriller"], "A seismologist, a mayor and a reporter race the clock in a city that is sure the big one will never come."],
  ["Second Shift", "", ["Comedy"], "The night staff of a 24-hour supermarket run the most chaotic, loyal and oddly heroic small business in town."],
  ["Brightwater", "", ["Drama", "Family"], "A widowed father moves his three children to the lake house where he grew up — and the lake remembers him."],
  ["Signal & Noise", "", ["Sci-Fi", "Thriller"], "A podcast about unexplained radio broadcasts gets an answer from its listeners' future."],
  ["Marrow Island", "", ["Mystery", "Horror"], "Every resident of a tiny island receives the same anonymous letter on the same morning."],
  ["Orbit Nine", "", ["Sci-Fi", "Comedy"], "Life aboard the least glamorous space station in the system, where the mail is late and the oxygen bill is due."],
  ["The Quiet Hours", "", ["Drama"], "Late-night radio host Iris answers the calls of a sleepless city, one voice at a time."],
  ["Copperhead County", "", ["Crime", "Drama"], "A new sheriff in a county that has buried three of them in ten years."],
  ["Blue Meridian", "", ["Adventure", "Documentary"], "A crew sails around the world along a single line of longitude, meeting everyone who lives on it."],
  ["Hollowgate", "", ["Fantasy", "Adventure"], "Behind a door in a boarding school's oldest wall lies a city that has been waiting for its students to come back."],
  ["Kingsbridge", "", ["Drama", "Crime"], "Three families, one bridge and the decades-old toll that none of them ever stopped paying."],
  ["Long Night", "", ["Thriller", "Mystery"], "In a northern town where the sun doesn't rise for weeks, a disappearance turns neighbours into suspects."],
  ["Starfall Protocol", "", ["Sci-Fi", "Action"], "When debris from a secret satellite falls on a small town, everyone in it becomes a person of interest."],
  ["River of Glass", "", ["Drama", "Mystery"], "A river guide in the marshes searches for her missing sister among people who know the water better than the law."],
  ["Northern Lights", "", ["Romance", "Drama"], "A tour guide in the far north falls for the one guest who came to see the aurora and refuses to look up."],
  ["The Night Kitchen", "", ["Comedy", "Drama"], "A restaurant that only opens after midnight, and the regulars who would be lost without it."],
  ["Wolf Creek Rangers", "", ["Adventure", "Family"], "Teenage volunteers in a national park learn that the wilderness keeps its own rules."],
  ["Parallel Avenue", "", ["Sci-Fi", "Mystery"], "Every resident of one city street has a double living on an identical street, and one of them has crossed over."],
];

const GENRES = ["Drama", "Crime", "Action", "Comedy", "Adventure", "Thriller", "Sci-Fi", "Romance", "Mystery", "Animation", "Fantasy", "Family", "Horror", "Documentary"];
const NAMES = ["Mara Ellison", "Jonah Vale", "Priya Anand", "Tomas Reyes", "Lena Fischer", "Odin Marsh", "Sofia Lund", "Caleb Stone", "Noor Haddad", "Ezra Finch", "Ines Duarte", "Felix Brandt", "Ada Okafor", "Rafe Kerr", "Yara Solberg", "Milo Ivers"];

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const build = () => {
  const out = { movie: [], series: [] };
  for (const [ti, [type, list]] of [["movie", FILMS], ["series", SERIES]].entries()) {
    const r = rng(311 + ti);
    list.forEach(([name, tagline, genres, description], i) => {
      const n = ti * 100 + i;
      const id = `tt7${String(200000 + n).padStart(6, "0")}`;
      const year = 2026 - Math.floor(r() * r() * 14) - (i < 6 ? 0 : 1);
      out[type].push({
        id,
        type,
        name,
        tagline,
        releaseInfo: type === "series" ? `${year}-` : String(year),
        poster: `https://images.metahub.space/poster/small/${id}/img`,
        background: `https://images.metahub.space/background/medium/${id}/img`,
        description,
        imdbRating: (6.6 + r() * 2.6).toFixed(1),
        genres,
        runtime: type === "movie" ? `${92 + Math.floor(r() * 50)} min` : `${38 + Math.floor(r() * 22)} min`,
        cast: [0, 1, 2, 3].map((k) => NAMES[(n * 3 + k * 5) % NAMES.length]),
        director: [NAMES[(n + 7) % NAMES.length]],
      });
    });
  }
  return out;
};

const CATALOGUE = build();
const byId = new Map([...CATALOGUE.movie, ...CATALOGUE.series].map((m) => [m.id, m]));

const EPISODES = ["The Crossing", "Low Water", "What the Map Forgot", "A Light in the Window", "Undercurrent", "Old Friends", "The Long Way Round", "Home Again"];
const videos = (m) => {
  const out = [];
  const year = parseInt(m.releaseInfo, 10) || 2022;
  for (let s = 1; s <= 2; s++) {
    for (let e = 1; e <= 8; e++) {
      out.push({
        id: `${m.id}:${s}:${e}`,
        season: s,
        episode: e,
        name: EPISODES[(e - 1 + s) % EPISODES.length],
        overview: "Old loyalties are tested when a stranger arrives with a story nobody wants to believe.",
        released: new Date(Date.UTC(Math.min(year + s - 1, 2026), 1, e * 3)).toISOString(),
        thumbnail: `https://episodes.metahub.space/${m.id}/${s}/${e}/w780.jpg`,
      });
    }
  }
  return out;
};
const meta = (type, id) => {
  const m = byId.get(id);
  if (!m || m.type !== type) return null;
  return { ...m, ...(type === "series" ? { videos: videos(m) } : {}) };
};

const page = (type, catalogId, { genre = "", skip = 0, search = "" } = {}) => {
  let list = CATALOGUE[type] || [];
  if (search) {
    const q = search.toLowerCase();
    return list.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 30);
  }
  if (catalogId === "year") list = list.filter((m) => String(parseInt(m.releaseInfo, 10)) === String(genre));
  else if (genre) list = list.filter((m) => m.genres.includes(genre));
  if (catalogId === "imdbRating") list = [...list].sort((a, b) => parseFloat(b.imdbRating) - parseFloat(a.imdbRating));
  return list.slice(skip, skip + 50);
};

const discoverSeed = () => {
  const item = (m, type) => ({
    type: type === "series" ? "show" : "movie",
    title: m.name,
    year: parseInt(m.releaseInfo, 10),
    poster: m.poster,
    backdrop: m.background,
    synopsis: m.description.slice(0, 400),
    rating: parseFloat(m.imdbRating),
    genres: m.genres,
    imdbId: m.id,
  });
  return {
    fetchedAt: Date.now(),
    v: 3,
    movies: CATALOGUE.movie.map((m) => item(m, "movie")),
    shows: CATALOGUE.series.map((m) => item(m, "series")),
  };
};

// For make-art.py: every title's id, name and kind.
const artList = () => [...CATALOGUE.movie, ...CATALOGUE.series].map((m) => ({ id: m.id, name: m.name, kind: m.type, tagline: m.tagline || "" }));

module.exports = { CATALOGUE, GENRES, meta, page, discoverSeed, byId, artList };
