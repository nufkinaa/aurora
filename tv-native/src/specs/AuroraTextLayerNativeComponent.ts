// render switch `herotext` (docs/qa/native-deep/DEVICE-PLAN.md §herotext). Fabric codegen
// reads this file; the Kotlin side is android/app/src/main/java/com/auroratv/ui/view/
// AuroraTextLayerView.kt + AuroraTextLayerManager.kt.
//
// A plain container (every View prop is RN's own) for Home's billboard words — the kicker,
// the title, the facts line and the synopsis — that holds ONE hardware layer while it is
// drawn whole: its own and every ancestor's opacity 1 and scale 1. Then the words and their
// blurred text shadows (5.2.0's look: radius 6–16) are rendered once and composited as one
// quad on every later frame (the column's slide, the trailer under them, the shelves moving).
// While the slide crossfades (`swap`), or on a canvas the app scales (src/canvas.tsx), it
// holds no layer, so those frames are drawn exactly as without it.
import {codegenNativeComponent} from 'react-native';
import type {HostComponent, ViewProps} from 'react-native';

export interface NativeProps extends ViewProps {}

export default codegenNativeComponent<NativeProps>('AuroraTextLayer') as HostComponent<NativeProps>;
