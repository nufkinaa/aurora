/**
 * Aurora for Android phones — the JS entry of the phone build
 * (`gradlew assembleRelease -Paurora=phone`, android/app/build.gradle).
 * The TV app's entry is index.js; neither bundle carries the other's screens.
 *
 * @format
 */

import './src/phone/mark'; // MUST stay first: the shared modules ask isPhone()
import {AppRegistry} from 'react-native';
import PhoneApp from './src/phone/PhoneApp';

AppRegistry.registerComponent('AuroraPhone', () => PhoneApp);
