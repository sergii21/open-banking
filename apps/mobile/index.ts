// The text decoder the statement readers need (Windows-1251) has to be in place before any of them loads.
import './src/platform/text-decoder';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
