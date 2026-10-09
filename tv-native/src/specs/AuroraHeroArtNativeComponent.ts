// Home's billboard art stack (P4 of docs/native-rewrite/00-plan.md; 01-architecture.md §2.4).
// Fabric codegen reads this file; the Kotlin side is android/app/src/main/java/com/auroratv/
// ui/view/AuroraHeroArtView.kt + AuroraHeroArtManager.kt.
//
// One view draws what Home.tsx's `HeroArt` builds from five: the REST picture, the SCROLLED
// picture (opacity 1 - atTop), its React children (the trailer layer — still RN), the dim
// and hero-scrim.png, in that order. It also carries the `artFade` wrapper's job: its own
// opacity is the column's offset run through the same clamped interpolation.
//
// Nothing here is driven from JS after the props land. `atTop` (280 ms) and the fade with
// the scroll both come from the AuroraSlideColumn that shares `link`, on the UI thread.
//
// Every address arrives RESOLVED from Home.tsx's `heroLayers` (api.ts imgSrc / artPath):
// this file does not know what an art URL looks like, it loads what it is handed with the
// request React Native's own <Image> would make (01-architecture.md §7), so the bitmaps are
// the ones already in the cache.
import {codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';

export interface NativeProps extends ViewProps {
  // The AuroraSlideColumn this art follows (same string on both).
  link?: string;
  // `art.rest`: the picture at rest, its headers as JSON ('' when none), and the on-box
  // `blurRadius` in dp (0 when the server blurred it, or for a sharp still).
  restUri?: string;
  restHeadersJson?: string;
  restBlur?: CT.WithDefault<CT.Float, 0>;
  // `scrolledArt.scrolled`: '' while that layer is not mounted (Home.tsx scrolledIdx).
  scrolledUri?: string;
  scrolledHeadersJson?: string;
  scrolledBlur?: CT.WithDefault<CT.Float, 0>;
  // REST.dim / SCROLLED.dim — the black scrim's alpha at atTop 1 / 0.
  restDim?: CT.WithDefault<CT.Double, 0.45>;
  scrolledDim?: CT.WithDefault<CT.Double, 0.42>;
  // The art fade's stops, dp of column offset: gone at `fadeOutAt` (-round(heroH*0.9)),
  // whole from `fadeInAt` (-round(heroH*0.3)) up to 0. Both 0 = never fades.
  fadeOutAt?: CT.WithDefault<CT.Double, 0>;
  fadeInAt?: CT.WithDefault<CT.Double, 0>;
}

export default codegenNativeComponent<NativeProps>('AuroraHeroArt') as HostComponent<NativeProps>;
