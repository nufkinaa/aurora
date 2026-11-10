// The edge of a glass pane - its soft shadow outside, the light inside its rim - drawn by
// ONE native view (components/GlassEdge.tsx; docs/glass-tv.md). Fabric codegen reads this
// file; the Kotlin side is android/app/src/main/java/com/auroratv/ui/view/
// AuroraGlassEdgeView.kt + AuroraGlassEdgeManager.kt.
//
// The five props are the names Android gave the bundled pictures (drawable resources, as
// Image.resolveAssetSource says them): the top corner, the foot corner ('' on a sheet that
// stands on the screen's foot), and the three runs. The view draws the left corners as they
// are, the right ones mirrored, and stretches a run between them - what GlassEdge.tsx lays
// out with eight <Image>s where there is no native view (Metro, the sandbox).
import {codegenNativeComponent} from 'react-native';
import type {HostComponent, ViewProps} from 'react-native';

export interface NativeProps extends ViewProps {
  cornerTop?: string;
  cornerFoot?: string;
  runTop?: string;
  runFoot?: string;
  runSide?: string;
}

export default codegenNativeComponent<NativeProps>('AuroraGlassEdge') as HostComponent<NativeProps>;
