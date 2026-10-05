// The TV app, mounted in a browser frame. App.tsx and everything under src/ are
// the real files — only `react-native` and three native libraries are swapped
// for web stand-ins (shims/, wired in serve.js).
import {AppRegistry} from 'react-native';
import App from '../App';
import {navRef} from '../src/rootNav';

// Back with nobody listening pops the navigator, as Android's would.
window.__tvBack = () => {
  if (navRef.isReady() && navRef.canGoBack()) navRef.goBack();
};
// for poking at it from the console / the host page
window.__nav = navRef;

AppRegistry.registerComponent('AuroraTV', () => App);
AppRegistry.runApplication('AuroraTV', {rootTag: document.getElementById('root')});
