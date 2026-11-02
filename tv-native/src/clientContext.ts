// This app, as a report says it (reportFields.ts has the shape).
import {Platform} from 'react-native';
import {recentErrors} from './errors';
import {isPhone} from './formFactor';
import {isOpen} from './realtime';
import {clientFields} from './reportFields';
import {APP_VERSION, PHONE_APP_VERSION} from './update';

export const clientContext = () => {
  const c = Platform.constants as {Model?: string; Release?: string};
  return clientFields({
    phone: isPhone(),
    tvVersion: APP_VERSION,
    phoneVersion: PHONE_APP_VERSION,
    release: c.Release,
    model: c.Model,
    // (whether the app's socket to the server is up)
    online: isOpen(),
    errors: recentErrors(),
  });
};
