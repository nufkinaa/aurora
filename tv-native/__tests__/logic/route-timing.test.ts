// The `route` usage event (routeTiming.ts): time from the navigation to the
// screen's content, once per visit; a return is counted, not timed.
import * as usage from '../../src/usage';
import * as navLock from '../../src/navLock';
import {routeShown, routeStarted, _routeInternals} from '../../src/routeTiming';

let events: Record<string, unknown>[];
beforeEach(() => {
  events = [];
  _routeInternals.reset();
  jest.restoreAllMocks();
  jest.spyOn(usage, 'track').mockImplementation((n: string, p?: Record<string, unknown>) => {
    if (n === 'route') events.push(p || {});
  });
  jest.spyOn(navLock, 'lastNavAt').mockReturnValue(0);
});

test('a screen is timed from the press that asked for it to its content, under its OWN name', () => {
  (navLock.lastNavAt as jest.Mock).mockReturnValue(10_000); // the press
  routeStarted('tv:browse/movie', 'k1', 10_180); // the navigator announces it
  expect(events).toEqual([]); // nothing yet: no content
  routeShown('k1', true, 10_900); // its first page is on
  expect(events).toEqual([{r: 'tv:browse/movie', ms: 900}]);
  // only once per visit
  routeShown('k1', true, 12_000);
  expect(events).toHaveLength(1);
});

test('the time spent on the PREVIOUS screen is never what is sent', () => {
  routeStarted('tv:home', 'home', 0);
  routeShown('home', true, 400);
  // two minutes on Home, then a title
  (navLock.lastNavAt as jest.Mock).mockReturnValue(120_000);
  routeStarted('tv:detail', 'd1', 120_050);
  routeShown('d1', true, 120_650);
  expect(events).toEqual([
    {r: 'tv:home', ms: 400},
    {r: 'tv:detail', ms: 650},
  ]);
});

test('content that was ready in the first commit (it reports before the navigator does) is still timed', () => {
  (navLock.lastNavAt as jest.Mock).mockReturnValue(5_000);
  routeShown('k2', true, 5_060);
  routeStarted('tv:whatsnew', 'k2', 5_070);
  expect(events).toEqual([{r: 'tv:whatsnew', ms: 60}]);
});

test('a return to a screen that is still drawn is a visit without a time', () => {
  routeStarted('tv:home', 'home', 0);
  routeShown('home', true, 300);
  routeStarted('tv:detail', 'd1', 1_000);
  routeShown('d1', true, 1_500);
  routeStarted('tv:home', 'home', 9_000); // Back
  routeShown('home', false, 9_001);
  expect(events[2]).toEqual({r: 'tv:home'});
});

test('a press long before (Back, an episode that started by itself) is not the start', () => {
  (navLock.lastNavAt as jest.Mock).mockReturnValue(1_000);
  routeStarted('tv:player', 'p2', 60_000);
  routeShown('p2', true, 61_200);
  expect(events).toEqual([{r: 'tv:player', ms: 1200}]);
});

test('leaving before the content came, or a screen that never reports, still counts as a visit', () => {
  routeStarted('tv:search', 's1', 0);
  routeStarted('tv:home', 'home', 4_000);
  expect(events).toEqual([{r: 'tv:search'}]);
});
