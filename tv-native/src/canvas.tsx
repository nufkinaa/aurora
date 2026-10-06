// THE LOGICAL CANVAS. Android TV panels do not agree on a dp size: the Google
// TV Streamer and most 1080p sets lay out at 960×540, many sets report
// 1280×720, and 4K sets 1920×1080 — the same app, drawn in fixed dp, was a
// tiny interface sitting low on the big panels (elia: 4K 16:9 and 16:10 are
// the sets that matter most, 2026-10-06).
//
// So the app lays out at 960 dp WIDE, always, and this view scales that canvas
// to fill the real window — a 1920-wide panel gets everything exactly twice
// the size, a 1280 one 1.33×. The width is the anchor; a 16:10 panel simply
// gets a taller canvas (960×600) and the layout flows into it. Text stays
// vector-sharp through the matrix; bitmaps decode at the logical size and are
// upscaled, which posters survive. On a 960-wide panel nothing changes at all:
// the children render untransformed.
//
// Everything that reads the window size goes through useTvMetrics (theme.ts),
// which reads THIS context first — so "76% of the height" is 76% of the canvas.
//
// The one native view that ignores a parent's matrix is a SurfaceView, which
// is why the player asks for a TextureView when the canvas is scaled
// (Player.tsx, viewType).
import React, {createContext, useContext, useMemo} from 'react';
import {View, useWindowDimensions} from 'react-native';

export const BASE_W = 960;

type Canvas = {width: number; height: number; scale: number};
const CanvasContext = createContext<Canvas | null>(null);

export const useCanvas = () => useContext(CanvasContext);
/** The factor the logical canvas is drawn at (1 on a 960-wide panel). */
export const useCanvasScale = () => useContext(CanvasContext)?.scale ?? 1;

export function TvCanvas({children}: {children: React.ReactNode}) {
  const {width, height} = useWindowDimensions();
  const canvas = useMemo<Canvas>(() => {
    const scale = width / BASE_W;
    return {width: BASE_W, height: Math.round(height / scale), scale};
  }, [width, height]);
  if (Math.abs(canvas.scale - 1) < 0.01) {
    return (
      <CanvasContext.Provider value={{width, height, scale: 1}}>{children}</CanvasContext.Provider>
    );
  }
  // Positioned at the origin at its logical size, then moved so its centre
  // meets the window's centre and scaled about that centre: it fills the
  // window exactly.
  return (
    <CanvasContext.Provider value={canvas}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: canvas.width,
          height: canvas.height,
          transform: [
            {translateX: (width - canvas.width) / 2},
            {translateY: (height - canvas.height) / 2},
            {scale: canvas.scale},
          ],
        }}>
        {children}
      </View>
    </CanvasContext.Provider>
  );
}
