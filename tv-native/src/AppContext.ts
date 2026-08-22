// App-wide context for the authenticated session: which profile is active and
// how to leave it. Screens read profileId to call the API; the header's
// "switch profile" calls switchProfile.
import {createContext, useContext} from 'react';

export type AppCtx = {
  profileId: string;
  switchProfile: () => void;
};

export const AppContext = createContext<AppCtx>({
  profileId: '',
  switchProfile: () => {},
});

export const useApp = () => useContext(AppContext);
