// The phone's profile menu (src/phone/profileMenu.ts): its lines in order, and
// Calendar — right after Your TVs — opening the shared "Calendar" route.
jest.mock('react-native', () => ({...jest.requireActual('./rn-stub.js'), Linking: {openURL: () => Promise.resolve()}}));
const mockPushScreen = jest.fn();
jest.mock('../../src/rootNav', () => ({pushScreen: (...a: unknown[]) => mockPushScreen(...a)}));
const mockPushPhone = jest.fn();
jest.mock('../../src/phone/nav', () => ({pushPhone: (...a: unknown[]) => mockPushPhone(...a)}));
jest.mock('../../src/api', () => ({getAuthMode: () => 'open', getBaseUrl: () => 'https://example.test'}));
jest.mock('../../src/overlay', () => ({openJoinParty: () => {}, openReport: () => {}}));

import {menuItems} from '../../src/phone/profileMenu';

test('Calendar follows Your TVs, with its own control id', () => {
  const items = menuItems(false);
  expect(items.map(i => i.label)).toEqual(['Switch profile', 'Settings', 'My downloads', 'Your TVs', 'Calendar', "What's new", 'Get the apps', 'Report a problem', 'Join a watch party', 'Pick together']);
  const cal = items.find(i => i.label === 'Calendar')!;
  expect(cal.uiId).toBe('phone.menu.calendar');
  expect(items[items.indexOf(cal) - 1].uiId).toBe('phone.menu.remote');
});

test('Calendar opens the shared Calendar route', () => {
  menuItems(true)
    .find(i => i.label === 'Calendar')!
    .onPress();
  expect(mockPushScreen).toHaveBeenCalledWith('Calendar', undefined);
  expect(mockPushPhone).not.toHaveBeenCalled();
});
