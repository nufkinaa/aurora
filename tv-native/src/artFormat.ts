// LAB ONLY — the art-format experiment's switch (docs/qa/native-bench/ART-FORMAT-PLAN.md).
// OFF by default: the lab app asks for exactly the pictures it always did.
//
// `artWebp` ON makes api.ts
//   (a) add `&fmt=webp` to the home hero's blurred addresses (artPath), and
//   (b) send the title page's backdrop through the server at the size it is drawn
//       (backdropSrc → /img/ext?u=…&w=1600|1920) instead of the catalogue's original —
// both only against a server whose /api/ping says `imgFmt: ["webp"]`.
//
// Read ONCE at startup from the AuroraArt native module's constants
// (android/.../ui/art/ArtFormat.kt: a marker file in the app's external files dir).
// Flip it, then relaunch:
//
//   adb shell touch /sdcard/Android/data/com.auroratv.lab/files/art-webp     # on
//   adb shell rm -f /sdcard/Android/data/com.auroratv.lab/files/art-webp     # off
//   adb shell am force-stop com.auroratv.lab
//
// FORCE: set to true/false to pin the switch in a build without the marker file
// (the sandbox, or a box whose shell cannot write there). null = ask the box.
import {NativeModules} from 'react-native';

const FORCE: boolean | null = null;

type Constants = {webp?: boolean; probe?: boolean; server?: string};

const read = (): Constants => {
  try {
    const m = NativeModules.AuroraArt as (Constants & {getConstants?: () => Constants}) | undefined;
    if (!m) return {};
    return (m.getConstants ? m.getConstants() : m) || {};
  } catch {
    return {};
  }
};
const c = read();

/** Is the WebP art experiment on for this launch? */
export const artWebp = (): boolean => (FORCE !== null ? FORCE : c.webp === true);

/** Is the native decode probe (logcat tag AuroraArt) on for this launch? */
export const artProbe = (): boolean => c.probe === true;

/**
 * A lab server to try before the app's own list ("" = none): the first line of
 * the `art-server` marker file, e.g.
 *   adb shell "echo http://192.168.50.108:4100 > /sdcard/Android/data/com.auroratv.lab/files/art-server"
 * For measuring against the lab tree's server while the real one keeps port 4000.
 */
export const artServer = (): string => (typeof c.server === 'string' && /^https?:\/\/[A-Za-z0-9.:-]+$/.test(c.server) ? c.server : '');
