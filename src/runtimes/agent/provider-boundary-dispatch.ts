export interface StructuredProviderTurn {
  readonly applicationContext: readonly string[];
  readonly userText: string;
}

export type ProviderTurnInput = string | StructuredProviderTurn;

export function isStructuredProviderTurn(
  input: ProviderTurnInput,
): input is StructuredProviderTurn {
  return typeof input !== 'string';
}

export function withProviderApplicationContext(
  input: ProviderTurnInput,
  applicationContext: string,
): StructuredProviderTurn {
  return isStructuredProviderTurn(input)
    ? {
        applicationContext: [applicationContext, ...input.applicationContext],
        userText: input.userText,
      }
    : { applicationContext: [applicationContext], userText: input };
}

export interface ProviderBoundarySession {
  sendTurn(input: ProviderTurnInput): Promise<void>;
  sendTurnAtProviderBoundary?(input: ProviderTurnInput, onReady?: () => void): Promise<void>;
}

/** Prefer exact-boundary dispatch while preserving injected legacy sessions. */
export async function dispatchProviderTurn(
  session: ProviderBoundarySession,
  input: ProviderTurnInput,
  onReady: () => void,
): Promise<void> {
  if (typeof session.sendTurnAtProviderBoundary === 'function') {
    await session.sendTurnAtProviderBoundary(input, onReady);
    return;
  }
  onReady();
  await session.sendTurn(input);
}
