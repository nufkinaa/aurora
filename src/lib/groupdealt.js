// "What do we watch tonight?" — what this household has already been dealt
// (2026-11-22). elia: Pick together "should not reuse content at all".
//
// Every card a Pick-together deck shows (the first deal, each "Swipe another
// round", a title added during swiping) is remembered here for every person
// in the room — the voters and the room's screen — and a later deck for any
// of them never deals it again. The sessions themselves stay in memory
// (lib/grouppick.js: a session is an evening); this is the one thing kept:
// which titles, for whom, and when. Nothing about who said what.
//
// A title is remembered by every name it goes by — its card key ("lib:<id>"
// for a library title, the IMDb id for a catalogue one) and its IMDb id — so a
// film dealt from the catalogue one night is not dealt again from the library
// after it was downloaded.
//
// data/group-dealt.json: { v: 1, people: { <profileId>: { <key>: <dealt at ms> } } }
// At most MAX_PER_PERSON names a person (the oldest go first: a household that
// has been dealt thousands of titles has long forgotten the first ones).
"use strict";
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const MAX_PER_PERSON = 8000;

let store = null;
const db = () => {
  if (!store) {
    store = new JsonStore(path.join(config.DATA_DIR, "group-dealt.json"), () => ({ v: 1, people: {} }), { kind: "state" });
    if (!store.data.people || typeof store.data.people !== "object" || Array.isArray(store.data.people)) store.data.people = {};
  }
  return store;
};

const namesOf = (card) => {
  const out = [];
  if (!card) return out;
  if (card.key) out.push(String(card.key));
  if (card.imdbId && card.imdbId !== card.key) out.push(String(card.imdbId));
  if (card.id && `lib:${card.id}` !== card.key) out.push(`lib:${card.id}`);
  return out;
};

// Every name any of these people has been dealt.
const dealtFor = (profileIds = []) => {
  const out = new Set();
  const people = db().data.people;
  for (const pid of profileIds) {
    const had = people[pid];
    if (!had) continue;
    for (const k of Object.keys(had)) out.add(k);
  }
  return out;
};

// These cards were dealt to these people now.
const remember = (profileIds = [], cards = [], at = Date.now()) => {
  const s = db();
  const names = [];
  for (const c of cards) names.push(...namesOf(c));
  if (!names.length || !profileIds.length) return 0;
  for (const pid of profileIds) {
    if (!pid) continue;
    const had = s.data.people[pid] || (s.data.people[pid] = {});
    for (const k of names) had[k] = at;
    const keys = Object.keys(had);
    if (keys.length > MAX_PER_PERSON) {
      keys.sort((a, b) => had[a] - had[b]);
      for (const k of keys.slice(0, keys.length - MAX_PER_PERSON)) delete had[k];
    }
  }
  s.save();
  return names.length;
};

// How many titles a person has been dealt (for the admin / tests).
const countFor = (profileId) => Object.keys(db().data.people[profileId] || {}).length;

module.exports = { dealtFor, remember, countFor, namesOf, MAX_PER_PERSON, _internals: { db } };
