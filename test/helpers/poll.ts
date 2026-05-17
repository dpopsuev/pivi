/** Poll predicate until it returns true or timeout elapses. */
export async function poll(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`poll() timed out after ${timeoutMs}ms`);
}
