export async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condição não atingida no prazo");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
