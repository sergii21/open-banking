/** Injected so expiry, cool-downs and seeded history are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(
  iso: string,
): Clock & { set(iso: string): void; advance(ms: number): void } {
  let current = new Date(iso).getTime();
  return {
    now: () => new Date(current),
    set: (next) => {
      current = new Date(next).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
