import { systemClock, type Clock } from '@api/clock';
import { Calendar } from '@api/domain/calendar';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState as NativeAppState } from 'react-native';
import { demoBank, liveBank } from './bank/provider';
import { Sync, type SyncState } from './bank/sync';
import { Store } from './data/db';
import { keychainVault } from './platform/keychain';
import { openPhoneDb } from './platform/sqlite';

export interface AppServices {
  store: Store;
  clock: Clock;
  /** Days and months are the person's own: Europe/Kyiv, wherever the phone is. */
  calendar: Calendar;
  sync: Sync;
  syncState: SyncState;
  /** Goes up whenever stored data may have changed: screens reload from the store when it does. */
  version: number;
  touch(): void;
  connect(token: string): Promise<void>;
  startDemo(): Promise<void>;
  disconnect(): Promise<void>;
}

const Context = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const value = useContext(Context);
  if (!value) throw new Error('The app is not ready yet.');
  return value;
}

/** Runs an async read whenever the stored data changes and keeps the last answer on screen while the next one loads. */
export function useStored<T>(
  read: (app: AppServices) => Promise<T>,
  extra: unknown = null,
): T | null {
  const app = useApp();
  const [value, setValue] = useState<T | null>(null);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    let live = true;
    void reader.current(app).then((next) => {
      if (live) setValue(next);
    });
    return () => {
      live = false;
    };
    // `app` is a new object on every change of `version`; reading again on each is the point.
  }, [app, extra]);
  return value;
}

export function AppProvider(props: { children: ReactNode; fallback: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [version, setVersion] = useState(0);
  const calendar = useMemo(() => new Calendar('Europe/Kyiv'), []);
  const clock = systemClock;

  const touch = useCallback(() => setVersion((n) => n + 1), []);

  const makeSync = useCallback(
    (onStore: Store, demo: boolean): Sync =>
      new Sync(
        demo ? demoBank(clock, calendar) : liveBank(clock, calendar),
        onStore,
        keychainVault,
        clock,
        calendar,
      ),
    [calendar, clock],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const opened = await Store.open(await openPhoneDb());
      const first = makeSync(opened, (await opened.meta('connected')) === 'demo');
      await first.resume();
      if (!live) return;
      setStore(opened);
      setSync(first);
    })();
    return () => {
      live = false;
    };
  }, [makeSync]);

  // The loop: one step, wait as long as it says, again. It stops in the background, where iOS would stop it anyway.
  useEffect(() => {
    if (!sync) return undefined;
    setSyncState(sync.current);
    const unsubscribe = sync.subscribe((state) => {
      setSyncState(state);
      touch();
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (stopped || running || NativeAppState.currentState !== 'active') return;
      running = true;
      let wait: number | null;
      try {
        wait = await sync.step();
      } finally {
        running = false;
      }
      if (!stopped && wait !== null) timer = setTimeout(() => void tick(), wait);
    };
    const kick = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      void tick();
    };
    const appState = NativeAppState.addEventListener('change', (next) => {
      if (next === 'active') kick();
    });
    const wake = sync.subscribe((state) => {
      // A connect or a refresh from a screen: start again at once instead of sleeping out the old wait.
      if (state.status === 'waiting' && state.nextAt === null) kick();
    });
    kick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      appState.remove();
      unsubscribe();
      wake();
    };
  }, [sync, touch]);

  const services = useMemo<AppServices | null>(() => {
    if (!store || !sync || !syncState) return null;
    const use = async (demo: boolean, token: string): Promise<void> => {
      const next = makeSync(store, demo);
      await next.connect(token);
      setSync(next);
    };
    return {
      store,
      clock,
      calendar,
      sync,
      syncState,
      version,
      touch,
      connect: (token) => use(false, token),
      startDemo: () => use(true, ''),
      disconnect: async () => {
        await sync.disconnect();
        setSync(makeSync(store, false));
      },
    };
  }, [store, sync, syncState, version, touch, calendar, clock, makeSync]);

  if (!services) return <>{props.fallback}</>;
  return <Context.Provider value={services}>{props.children}</Context.Provider>;
}
