// The phone's profile menu (src/phone/profileMenu.ts): its lines in order, and
// Calendar — right after Your TVs — opening the shared "Calendar" route.
jest.mock('react-native', () => ({...jest.requireActual('./rn-stub.js'), Linking: {openURL: () => Promise.resolve()}}));
const mockPushScreen = jest.fn();
jest.mock('../../src/rootNav', () => ({pushScreen: (...a: unknown[]) => mockPushScreen(...a)}));
const mockPushPhone = jest.fn();
jest.mock('../../src/phone/nav', () => ({pushPhone: (...a: unknown[]) => mockPushPhone(...a)}));
jest.mock('../../src/api', () => ({getAuthMode: () => 'open', getBaseUrl: () => 'https://example.test'}));
jest.mock('../../src/overlay', () => ({openJoinParty: () => {}, openReport: () => {}, openChildMode: () => {}}));

import {menuItems} from '../../src/phone/profileMenu';

test('Calendar follows Your TVs, with its own control id', () => {
  const items = menuItems(false);
  expect(items.map(i => i.label)).toEqual(['Switch profile', 'Children mode', 'Settings', 'My downloads', 'Your TVs', 'Calendar', "What's new", 'Get the apps', 'Report a problem', 'Join a watch party', 'Pick together']);
  const cal = items.find(i => i.label === 'Calendar')!;
  expect(cal.uiId).toBe('phone.menu.calendar');
  expect(items[items.indexOf(cal) - 1].uiId).toBe('phone.menu.remote');
});

// Children mode (2026-11-11): its line under the first; while it is on, no
// Switch profile / Sign out and no downloads — the website's profile menu.
test('Children mode: its own line, and while it is on no switching profile and no downloads', () => {
  expect(menuItems(false, true).map(i => i.label)).toEqual(['Leave Children mode', 'Settings', 'Your TVs', 'Calendar', "What's new", 'Get the apps', 'Report a problem', 'Join a watch party', 'Pick together']);
  expect(menuItems(true, true).some(i => i.label === 'Sign out')).toBe(false);
  expect(menuItems(true, false)[1]).toMatchObject({label: 'Children mode', uiId: 'child.open'});
});

test('Calendar opens the shared Calendar route', () => {
  menuItems(true)
    .find(i => i.label === 'Calendar')!
    .onPress();
  expect(mockPushScreen).toHaveBeenCalledWith('Calendar', undefined);
  expect(mockPushPhone).not.toHaveBeenCalled();
});
