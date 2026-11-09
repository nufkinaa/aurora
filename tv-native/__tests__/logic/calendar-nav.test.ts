// The rail's Calendar (src/navSection.ts): its place — after AI, before
// Settings — and what pressing it does (the rail switches sections: back to
// Home, then the Calendar on top; nothing when it is already on).
jest.mock('../../src/api', () => ({api: {}}));
jest.mock('../../src/profileScope', () => ({registerProfileCache: () => {}}));
jest.mock('../../src/storage', () => ({loadNewSeen: () => Promise.resolve(null), saveNewSeen: () => {}}));
jest.mock('../../src/update', () => ({APP_VERSION: '0.0.0'}));
jest.mock('../../src/navLock', () => ({canNavigate: () => true}));

import {goSection, NAV_SECTIONS} from '../../src/navSection';

const navOn = (name: string) => ({
  getState: () => ({index: 0, routes: [{name, key: `${name}-1`}]}),
  popToTop: jest.fn(),
  push: jest.fn(),
});

test('Calendar is in the rail between AI and Settings', () => {
  const keys = NAV_SECTIONS.map(s => s.key);
  const at = keys.indexOf('calendar');
  expect(at).toBeGreaterThan(-1);
  expect(keys[at - 1]).toBe('ai');
  expect(keys[at + 1]).toBe('settings');
  expect(NAV_SECTIONS[at]).toMatchObject({key: 'calendar', label: 'Calendar'});
  expect(NAV_SECTIONS[at].foot).toBeFalsy();
});

test('pressing it goes back to Home and opens the Calendar', () => {
  const nav = navOn('Home');
  goSection(nav as never, 'home', 'calendar');
  expect(nav.popToTop).toHaveBeenCalled();
  expect(nav.push).toHaveBeenCalledWith('Calendar');
});

test('pressing it on the Calendar does nothing', () => {
  const nav = navOn('Calendar');
  goSection(nav as never, 'calendar', 'calendar');
  expect(nav.popToTop).not.toHaveBeenCalled();
  expect(nav.push).not.toHaveBeenCalled();
});

test('the rail tags it nav.calendar (the controls contract)', () => {
  const fs = require('fs');
  const path = require('path');
  const rail: string = fs.readFileSync(path.join(__dirname, '../../src/components/NavRail.tsx'), 'utf8');
  expect(rail).toMatch(/calendar: 'nav\.calendar'|NAV_UI\.calendar = 'nav\.calendar'/);
});
