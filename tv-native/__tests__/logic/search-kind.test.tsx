// Film or series on a search suggestion chip (src/searchKind.ts), the TV's and
// the phone's: a title's chip carries the card tags' glyph in their hue, a
// screen reader hears the word (the chip prints only the icon — elia's "A").
// People and genres keep their own chips.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native', () => ({...jest.requireActual('./rn-stub.js'), ActivityIndicator: 'ActivityIndicator'}));
// a host component by name, keeping its props (a function declaration: jest.mock is hoisted above it)
function mockHost(name: string) {
  const R = jest.requireActual('react');
  return {__esModule: true, default: (p: Record<string, unknown>) => R.createElement(name, p, p.children as never)};
}
jest.mock('../../src/components/Focusable', () => mockHost('Focusable'));
jest.mock('../../src/components/Icon', () => mockHost('Icon'));
jest.mock('../../src/phone/ui/Tap', () => mockHost('Tap'));
jest.mock('../../src/phone/ui/Icon', () => mockHost('PhoneIcon'));

import {kindSpoken, suggestionKind} from '../../src/searchKind';
import Chip from '../../src/components/Chip';
import {ChipButton} from '../../src/phone/ui/Buttons';
import theme from '../../src/theme';

const render = (el: React.ReactElement) => {
  let r: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r as unknown as TestRenderer.ReactTestRenderer;
};

describe('searchKind', () => {
  test('a title is a film or a series by its type; a person and a genre are neither', () => {
    expect(suggestionKind({kind: 'title', type: 'movie'})).toBe('film');
    expect(suggestionKind({kind: 'title', type: 'show'})).toBe('series');
    expect(suggestionKind({type: 'series'})).toBe('series'); // (an older answer without `kind`)
    expect(suggestionKind({kind: 'person'})).toBeNull();
    expect(suggestionKind({kind: 'genre'})).toBeNull();
  });
  test('the spoken label carries the word; a person or a genre is left as it is', () => {
    expect(kindSpoken('Dune (2021)', 'film')).toBe('Dune (2021), film');
    expect(kindSpoken('Severance (2022)', 'series')).toBe('Severance (2022), series');
    expect(kindSpoken('Tessa · person', null)).toBe('Tessa · person');
  });
});

describe('the chips', () => {
  test('TV Chip: the glyph in its hue before the words, and the spoken label', () => {
    const r = render(
      <Chip small label="Severance (2022)" icon="series" iconColor={theme.colors.kindSeries} accessibilityLabel="Severance (2022), series" onPress={() => {}} />,
    );
    const icon = r.root.findByType('Icon' as never);
    expect(icon.props).toMatchObject({name: 'series', color: theme.colors.kindSeries, size: 16});
    expect(r.root.findByType('Focusable' as never).props.accessibilityLabel).toBe('Severance (2022), series');
    expect(r.root.findByType('Text' as never).props.children).toBe('Severance (2022)');
  });
  test('TV Chip without an icon is as it was', () => {
    const r = render(<Chip small label="Clear" onPress={() => {}} />);
    expect(r.root.findAllByType('Icon' as never)).toHaveLength(0);
    expect(r.root.findByType('Focusable' as never).props.accessibilityLabel).toBeUndefined();
  });
  test('phone ChipButton: the glyph in its hue, the spoken label', () => {
    const r = render(
      <ChipButton label="Dune (2021)" icon="film" iconColor={theme.colors.kindFilm} a11yLabel="Dune (2021), film" onPress={() => {}} />,
    );
    expect(r.root.findByType('PhoneIcon' as never).props).toMatchObject({name: 'film', color: theme.colors.kindFilm});
    expect(r.root.findByType('Tap' as never).props.accessibilityLabel).toBe('Dune (2021), film');
    const plain = render(<ChipButton label="Tessa · person" icon="person" onPress={() => {}} />);
    expect(plain.root.findByType('Tap' as never).props.accessibilityLabel).toBe('Tessa · person');
  });
});
