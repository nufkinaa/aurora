// The native card's drawn layers (P2 of docs/native-rewrite/00-plan.md). Fabric codegen
// reads this file; the Kotlin side is android/app/src/main/java/com/auroratv/ui/view/
// AuroraCardView.kt + AuroraCardManager.kt.
//
// NOT a focusable: Card.tsx's native wrapper mounts this view inside the one `Focusable`
// the JS card uses (P1's switch), so the ring / scale / lift / press / long-press / focus
// events are that component's. Two instances per card: the ART layer (blur-up, picture,
// tile, shade at rest) as the first child, and the FOCUS layer (brighten, focus shade)
// inside the Focusable's `focusOverlay`, whose alpha the Focusable drives.
//
// Every address arrives RESOLVED from api.ts (imgSrc / artPath / artPx) — this file does
// not know what an art URL looks like, it only loads what it is handed, with the same
// Fresco request React Native's own <Image> would make (01-architecture.md §7).
import {codegenNativeCommands, codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';
import type * as React from 'react';

/** `uri` is always the FIRST address (Card.tsx keys by `src.uri`); `shown` the one that loaded/failed. */
export type ImageLoadedEvent = Readonly<{uri: string; shown: string}>;
export type ImageFailedEvent = Readonly<{
  uri: string;
  shown: string;
  error: string;
  // 1 on the first failure of this address (Card.tsx reports that one via trackError).
  tries: CT.Int32;
  // The titled tile is showing now.
  tile: boolean;
  // Three slow rounds failed: nothing more until the `unpark` command.
  parked: boolean;
}>;
/** A slow round (30 s / 120 s / 480 s) expired: back to the first address, tile gone. */
export type ImageRetryEvent = Readonly<{uri: string; round: CT.Int32}>;

export interface NativeProps extends ViewProps {
  // The picture (imgSrc(sizedPath || picture)): absent → the tile.
  uri?: string;
  // JSON of the source's headers ({X-Session, X-Profile}), '' when none.
  headersJson?: string;
  // artPath succeeded: the server sent the drawn size, so no on-device resize
  // (resizeMethod 'auto'); false → 'resize' = ResizeOptions(view px).
  sized?: CT.WithDefault<boolean, false>;
  // `<uri>?r=1` / `&r=1` (Card.tsx:217) — the once cache-busted retry.
  retryUri?: string;
  // The server's backup poster chain, sized (Card.tsx:203-209); absent when none.
  backupUri?: string;
  backupHeadersJson?: string;
  // The 16-px placeholder's data: URI (blur.ts), only when this run has not drawn `uri` yet.
  blurUri?: string;
  // 'none' | 'poster' (card-shade-v.png) | 'frame' (card-frame-shade.png), drawn over the picture.
  shade?: CT.WithDefault<string, 'none'>;
  // The white @0.055 wash (the focus layer).
  brighten?: CT.WithDefault<boolean, false>;
  // No picture at all (`!src`): draw the titled tile's gradient (the title is an RN Text child).
  tile?: CT.WithDefault<boolean, false>;
  onImageLoaded?: CT.DirectEventHandler<ImageLoadedEvent>;
  onImageFailed?: CT.DirectEventHandler<ImageFailedEvent>;
  onImageRetry?: CT.DirectEventHandler<ImageRetryEvent>;
}

type ComponentType = HostComponent<NativeProps>;

interface NativeCommands {
  // The realtime socket's `welcome`: a parked card asks again (Card.tsx:195-202).
  unpark: (viewRef: React.ElementRef<ComponentType>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['unpark'],
});

export default codegenNativeComponent<NativeProps>('AuroraCard') as ComponentType;
