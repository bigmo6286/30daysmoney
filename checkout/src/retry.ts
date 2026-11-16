/** Run `f` up to `tries` times, waiting `delayMs`, then twice that, … between tries; rethrows the last error. */
export async function retry<T>(f: () => Promise<T>, tries = 3, delayMs = 2_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(delayMs * 2 ** (i - 1));
    }
  }
}
