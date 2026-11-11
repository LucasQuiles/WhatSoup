export function dispatchInboundMessage(
  dispatch: () => void | Promise<void>,
  reportFailure: (error: unknown) => void,
): void {
  try {
    // Invoke synchronously to preserve adapter delivery order.
    void Promise.resolve(dispatch()).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}
