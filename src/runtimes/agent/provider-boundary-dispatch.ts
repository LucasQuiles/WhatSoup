export interface ProviderBoundarySession {
  sendTurn(text: string): Promise<void>;
  sendTurnAtProviderBoundary?(text: string, onReady?: () => void): Promise<void>;
}

/** Prefer exact-boundary dispatch while preserving injected legacy sessions. */
export async function dispatchProviderTurn(
  session: ProviderBoundarySession,
  text: string,
  onReady: () => void,
): Promise<void> {
  if (typeof session.sendTurnAtProviderBoundary === 'function') {
    await session.sendTurnAtProviderBoundary(text, onReady);
    return;
  }
  onReady();
  await session.sendTurn(text);
}
