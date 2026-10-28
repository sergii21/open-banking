import { buildApp, type BuiltApp } from '../src/app';
import { fixedClock } from '../src/clock';
import { loadConfig, type AppConfig } from '../src/config';
import { Db } from '../src/db/database';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    PROVIDERS: 'mock',
    PUBLIC_URL: 'http://localhost:4200',
  });
  return { ...base, ...overrides };
}

export interface TestApp extends BuiltApp {
  db: Db;
  clock: ReturnType<typeof fixedClock>;
  close(): Promise<void>;
}

/** A fully wired app on an in-memory database and a controllable clock. */
export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  clockIso = '2026-10-28T10:00:00.000Z',
): Promise<TestApp> {
  const clock = fixedClock(clockIso);
  const db = new Db(':memory:');
  const built = await buildApp({ config: testConfig(overrides), clock, db });
  await built.app.ready();
  return {
    ...built,
    db,
    clock,
    close: async () => {
      await built.app.close();
      db.close();
    },
  };
}
