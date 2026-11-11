// The More sheet's lines — PURE (no React Native), tested against
// docs/android-phone/NAV.md §2, which is the website's menu behind More
// (docs/web-nav.md, js/navmore.js) line for line: the same places, in the same
// order, in the same words. Change one, change both.
//
// The website's menu is the TV's side menu made for a finger; the phone app keeps
// its bottom sheet (a thumb reaches it), with the same lines in the same groups:
// the TV's places first (Search … AI), then the pages that have no tab, then the
// three actions, and Settings and you at the foot.
import type {PhoneIconName} from './ui/Icon';

export type MoreKey =
  | 'search' | 'home' | 'movies' | 'shows' | 'list' | 'calendar' | 'pick'
  | 'new' | 'saved' | 'downloads' | 'remote' | 'household' | 'wrapped' | 'taste' | 'apps'
  | 'children' | 'pair' | 'party' | 'report'
  | 'settings' | 'profile';

export type MoreEntry = {
  key: MoreKey;
  label: string;
  detail: string;
  icon: PhoneIconName;
  uiId: string;
  /** 'tv' the TV's places · 'places' the pages with no tab · 'actions' not pages · 'foot' Settings and you */
  group: 'tv' | 'places' | 'actions' | 'foot';
};

const ALL: MoreEntry[] = [
  {key: 'search', label: 'Search', detail: 'Titles, people, in English or Hebrew', icon: 'search', uiId: 'more.search', group: 'tv'},
  {key: 'home', label: 'Home', detail: 'Where you left off, and what is new', icon: 'home', uiId: 'more.home', group: 'tv'},
  {key: 'movies', label: 'Movies', detail: 'Every film on the server', icon: 'film', uiId: 'more.movies', group: 'tv'},
  {key: 'shows', label: 'Shows', detail: 'Every series on the server', icon: 'series', uiId: 'more.shows', group: 'tv'},
  {key: 'list', label: 'My List', detail: 'What you saved for later', icon: 'bookmark', uiId: 'more.list', group: 'tv'},
  // (a slot: listed once the app has a Calendar screen — branch release-calendar)
  {key: 'calendar', label: 'Calendar', detail: 'What comes out, and when', icon: 'calendar', uiId: 'more.calendar', group: 'tv'},
  {key: 'pick', label: 'AI', detail: 'Say the mood, get titles', icon: 'chat', uiId: 'more.pick', group: 'tv'},
  {key: 'new', label: "What's new", detail: 'The changes to Aurora, newest first', icon: 'sparkle', uiId: 'more.new', group: 'places'},
  {key: 'saved', label: 'Saved on this device', detail: 'Watch them with no connection', icon: 'downloadDevice', uiId: 'more.saved', group: 'places'},
  {key: 'downloads', label: 'My downloads', detail: 'What you asked the server to fetch', icon: 'download', uiId: 'more.downloads', group: 'places'},
  {key: 'remote', label: 'Your TVs', detail: 'This phone as the remote', icon: 'tv', uiId: 'more.remote', group: 'places'},
  {key: 'household', label: 'Recommended by your household', detail: 'What the others sent you', icon: 'send', uiId: 'more.household', group: 'places'},
  {key: 'wrapped', label: 'Your Aurora Wrapped', detail: 'Your year in numbers', icon: 'star', uiId: 'more.wrapped', group: 'places'},
  {key: 'taste', label: 'Swipe your taste', detail: 'One title at a time; Home learns', icon: 'people', uiId: 'more.taste', group: 'places'},
  {key: 'apps', label: 'Get the apps', detail: 'Aurora for the TV, the phone and the computer', icon: 'apps', uiId: 'more.apps', group: 'places'},
  // Children mode (childMode.ts): "Leave Children mode" while it is on
  {key: 'children', label: 'Children mode', detail: 'A clean feed for children, on every device', icon: 'child', uiId: 'more.children', group: 'actions'},
  {key: 'pair', label: 'Sign in a TV', detail: "Type or scan the code on a TV's screen", icon: 'remote', uiId: 'more.pair', group: 'actions'},
  {key: 'party', label: 'Join a watch party', detail: 'Type the code from another screen', icon: 'people', uiId: 'more.party', group: 'actions'},
  {key: 'report', label: 'Report a problem', detail: 'A few words; the rest comes along', icon: 'warning', uiId: 'more.report', group: 'actions'},
  {key: 'settings', label: 'Settings', detail: 'Playback, subtitles, saving, this phone', icon: 'gear', uiId: 'more.settings', group: 'foot'},
  {key: 'profile', label: 'Profile', detail: 'Switch profile, sign out', icon: 'person', uiId: 'more.profile', group: 'foot'},
];

// Not while Children mode is on: no downloads, no signing a TV in (the website's rule).
const NOT_IN_CHILD_MODE = new Set<MoreKey>(['saved', 'downloads', 'pair']);

/** The lines, in order. AI only when the server has AI (GET /api/ai/status); Calendar
 *  only once its screen exists; the profile line wears your name. `kids`: Children
 *  mode is on (its line reads "Leave Children mode"). */
export const moreEntries = ({ai, calendar = true, name = '', kids = false}: {ai: boolean; calendar?: boolean; name?: string; kids?: boolean}): MoreEntry[] =>
  ALL.filter(e => (e.key !== 'pick' || ai) && (e.key !== 'calendar' || calendar) && !(kids && NOT_IN_CHILD_MODE.has(e.key))).map(e =>
    e.key === 'profile' && name
      ? {...e, label: name}
      : e.key === 'children' && kids
        ? {...e, label: 'Leave Children mode', detail: 'Takes the passcode'}
        : e,
  );
