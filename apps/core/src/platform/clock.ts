/** El reloj es una dependencia: un test no puede esperar cuatro horas a que expire un run. */
export interface Clock {
  now(): Date;
  nowIso(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export function fixedClock(start: Date | string): Clock & { advance(ms: number): void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
    advance(ms: number) { current += ms; },
  };
}
