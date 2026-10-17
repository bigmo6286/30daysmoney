const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const min = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? LEVELS.info;

export function logger(scope: string) {
  const out = (level: Level, msg: string, extra?: unknown) => {
    if (LEVELS[level] < min) return;
    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(8)} · ${msg}`;
    (level === "error" || level === "warn" ? console.error : console.log)(extra === undefined ? line : `${line} ${String(extra)}`);
  };
  return {
    debug: (m: string, e?: unknown) => out("debug", m, e),
    info: (m: string, e?: unknown) => out("info", m, e),
    warn: (m: string, e?: unknown) => out("warn", m, e),
    error: (m: string, e?: unknown) => out("error", m, e),
  };
}
