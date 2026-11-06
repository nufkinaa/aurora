// The More sheet's lines — PURE (no React Native), tested against
// docs/android-phone/NAV.md §2, which the website's phone tab bar follows too:
// the same places, in the same order, in the same words. Change one, change both.
import type {PhoneIconName} from './ui/Icon';

export type MoreKey = 'new' | 'saved' | 'downloads' | 'remote' | 'household' | 'wrapped' | 'taste' | 'pick' | 'settings' | 'apps' | 'pair' | 'party' | 'report';

export type MoreEntry = {
  key: MoreKey;
  label: string;
  detail: string;
  icon: PhoneIconName;
  uiId: string;
  /** 'places' are pages; 'actions' (under the hairline) are not */
  group: 'places' | 'actions';
};

const ALL: MoreEntry[] = [
  {key: 'new', label: "What's new", detail: 'The changes to Aurora, newest first', icon: 'sparkle', uiId: 'more.new', group: 'places'},
  {key: 'saved', label: 'Saved on this phone', detail: 'Watch them with no connection', icon: 'downloadDevice', uiId: 'more.saved', group: 'places'},
  {key: 'downloads', label: 'My downloads', detail: 'What you asked the server to fetch', icon: 'download', uiId: 'more.downloads', group: 'places'},
  {key: 'remote', label: 'Your TVs', detail: 'This phone as the remote', icon: 'tv', uiId: 'more.remote', group: 'places'},
  {key: 'household', label: 'Recommended by your household', detail: 'What the others sent you', icon: 'send', uiId: 'more.household', group: 'places'},
  {key: 'wrapped', label: 'Your Aurora Wrapped', detail: 'Your year in numbers', icon: 'star', uiId: 'more.wrapped', group: 'places'},
  {key: 'taste', label: 'Swipe your taste', detail: 'One title at a time; Home learns', icon: 'people', uiId: 'more.taste', group: 'places'},
  {key: 'pick', label: 'AI pick', detail: 'Say the mood, get titles', icon: 'chat', uiId: 'more.pick', group: 'places'},
  {key: 'settings', label: 'Settings', detail: 'Playback, subtitles, saving, this phone', icon: 'gear', uiId: 'more.settings', group: 'places'},
  {key: 'apps', label: 'Get the apps', detail: 'Aurora for the TV, the phone and the computer', icon: 'apps', uiId: 'more.apps', group: 'places'},
  {key: 'pair', label: 'Sign in a TV', detail: "Type or scan the code on a TV's screen", icon: 'remote', uiId: 'more.pair', group: 'actions'},
  {key: 'party', label: 'Join a watch party', detail: 'Type the code from another screen', icon: 'people', uiId: 'more.party', group: 'actions'},
  {key: 'report', label: 'Report a problem', detail: 'A few words; the rest comes along', icon: 'warning', uiId: 'more.report', group: 'actions'},
];

/** The lines, in order. "AI pick" only when the server has AI (GET /api/ai/status). */
export const moreEntries = ({ai}: {ai: boolean}): MoreEntry[] => ALL.filter(e => e.key !== 'pick' || ai);
