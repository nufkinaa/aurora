// Synthetic people for the recommender's evaluation: each is a list of
// well-known titles such a person would have finished. They exist so the
// harness can show real titles in its examples and measure something without
// ever printing a household member's history. [title, year, "movie"|"tv"]
module.exports = [
  { id: "scifi-slowburn", name: "Sci-fi + slow-burn drama fan", titles: [
    ["Arrival", 2016, "movie"], ["Blade Runner 2049", 2017, "movie"], ["Ex Machina", 2015, "movie"],
    ["Interstellar", 2014, "movie"], ["Annihilation", 2018, "movie"], ["Her", 2013, "movie"],
    ["Moon", 2009, "movie"], ["Contact", 1997, "movie"], ["Gattaca", 1997, "movie"],
    ["Severance", 2022, "tv"], ["Devs", 2020, "tv"], ["Station Eleven", 2021, "tv"],
    ["Dark", 2017, "tv"], ["The Leftovers", 2014, "tv"], ["Solaris", 1972, "movie"],
  ] },
  { id: "family-animation", name: "Family animation", titles: [
    ["Toy Story", 1995, "movie"], ["Finding Nemo", 2003, "movie"], ["Coco", 2017, "movie"],
    ["Moana", 2016, "movie"], ["Zootopia", 2016, "movie"], ["How to Train Your Dragon", 2010, "movie"],
    ["Inside Out", 2015, "movie"], ["Ratatouille", 2007, "movie"], ["Up", 2009, "movie"],
    ["The Incredibles", 2004, "movie"], ["Kung Fu Panda", 2008, "movie"], ["Encanto", 2021, "movie"],
    ["Bluey", 2018, "tv"], ["Frozen", 2013, "movie"], ["Paddington 2", 2017, "movie"],
  ] },
  { id: "true-crime-docs", name: "True crime + documentaries", titles: [
    ["Making a Murderer", 2015, "tv"], ["The Jinx: The Life and Deaths of Robert Durst", 2015, "tv"],
    ["Tiger King", 2020, "tv"], ["Don't F**k with Cats: Hunting an Internet Killer", 2019, "tv"],
    ["Wild Wild Country", 2018, "tv"], ["The Staircase", 2004, "tv"], ["Icarus", 2017, "movie"],
    ["Free Solo", 2018, "movie"], ["The Tinder Swindler", 2022, "movie"],
    ["American Murder: The Family Next Door", 2020, "movie"], ["Mindhunter", 2017, "tv"],
    ["Zodiac", 2007, "movie"], ["13th", 2016, "movie"], ["The Imposter", 2012, "movie"],
    ["Abducted in Plain Sight", 2017, "movie"],
  ] },
  { id: "nineties-action", name: "90s action", titles: [
    ["Die Hard 2", 1990, "movie"], ["Terminator 2: Judgment Day", 1991, "movie"], ["Speed", 1994, "movie"],
    ["The Rock", 1996, "movie"], ["Face/Off", 1997, "movie"], ["Con Air", 1997, "movie"],
    ["True Lies", 1994, "movie"], ["Point Break", 1991, "movie"], ["Heat", 1995, "movie"],
    ["The Matrix", 1999, "movie"], ["Bad Boys", 1995, "movie"], ["Hard Boiled", 1992, "movie"],
    ["Under Siege", 1992, "movie"], ["GoldenEye", 1995, "movie"], ["Mission: Impossible", 1996, "movie"],
  ] },
  { id: "heists-cons", name: "Heists and con artists", titles: [
    ["Ocean's Eleven", 2001, "movie"], ["The Italian Job", 2003, "movie"], ["Inside Man", 2006, "movie"],
    ["The Town", 2010, "movie"], ["Money Heist", 2017, "tv"], ["Logan Lucky", 2017, "movie"],
    ["Baby Driver", 2017, "movie"], ["Now You See Me", 2013, "movie"], ["Catch Me If You Can", 2002, "movie"],
    ["The Sting", 1973, "movie"], ["Snatch", 2000, "movie"], ["Lupin", 2021, "tv"], ["Widows", 2018, "movie"],
    ["Hell or High Water", 2016, "movie"],
  ] },
  { id: "feelgood-romcom", name: "Feel-good comedy and romance", titles: [
    ["When Harry Met Sally...", 1989, "movie"], ["Notting Hill", 1999, "movie"], ["About Time", 2013, "movie"],
    ["Crazy Rich Asians", 2018, "movie"], ["The Proposal", 2009, "movie"],
    ["10 Things I Hate About You", 1999, "movie"], ["Bridget Jones's Diary", 2001, "movie"],
    ["Love Actually", 2003, "movie"], ["Ted Lasso", 2020, "tv"], ["Schitt's Creek", 2015, "tv"],
    ["Parks and Recreation", 2009, "tv"], ["Palm Springs", 2020, "movie"], ["The Big Sick", 2017, "movie"],
    ["Brooklyn Nine-Nine", 2013, "tv"],
  ] },
  { id: "elevated-horror", name: "Supernatural and slow-dread horror", titles: [
    ["Hereditary", 2018, "movie"], ["The Witch", 2016, "movie"], ["Midsommar", 2019, "movie"],
    ["It Follows", 2015, "movie"], ["The Babadook", 2014, "movie"], ["Get Out", 2017, "movie"],
    ["The Conjuring", 2013, "movie"], ["A Quiet Place", 2018, "movie"], ["Talk to Me", 2023, "movie"],
    ["The Haunting of Hill House", 2018, "tv"], ["Midnight Mass", 2021, "tv"], ["Sinister", 2012, "movie"],
    ["Barbarian", 2022, "movie"], ["The Others", 2001, "movie"],
  ] },
  { id: "crime-drama-tv", name: "Prestige crime drama", titles: [
    ["Breaking Bad", 2008, "tv"], ["The Sopranos", 1999, "tv"], ["The Wire", 2002, "tv"],
    ["Better Call Saul", 2015, "tv"], ["Ozark", 2017, "tv"], ["Fargo", 2014, "tv"], ["Narcos", 2015, "tv"],
    ["True Detective", 2014, "tv"], ["Peaky Blinders", 2013, "tv"], ["Boardwalk Empire", 2010, "tv"],
    ["GoodFellas", 1990, "movie"], ["The Departed", 2006, "movie"], ["Casino", 1995, "movie"],
    ["No Country for Old Men", 2007, "movie"],
  ] },
  { id: "epic-fantasy", name: "Epic fantasy", titles: [
    ["The Lord of the Rings: The Fellowship of the Ring", 2001, "movie"], ["Game of Thrones", 2011, "tv"],
    ["The Witcher", 2019, "tv"], ["Harry Potter and the Prisoner of Azkaban", 2004, "movie"],
    ["Pan's Labyrinth", 2006, "movie"], ["Stardust", 2007, "movie"], ["The Princess Bride", 1987, "movie"],
    ["House of the Dragon", 2022, "tv"], ["The Hobbit: An Unexpected Journey", 2012, "movie"],
    ["Shadow and Bone", 2021, "tv"], ["Spirited Away", 2001, "movie"], ["Willow", 1988, "movie"],
    ["The Chronicles of Narnia: The Lion, the Witch and the Wardrobe", 2005, "movie"],
  ] },
  // one profile, two people: the case a single taste centroid averages into mush
  { id: "shared-kids-horror", name: "Shared profile: a child's cartoons + a parent's horror", mix: ["family-animation", "elevated-horror"] },
];
