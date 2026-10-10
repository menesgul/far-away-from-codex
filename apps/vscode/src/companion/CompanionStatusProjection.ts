import { CompanionClient, CompanionClientError } from './CompanionClient';

export type CompanionStatusText =
  | 'Companion: Checking'
  | 'Companion: Connected (last check)'
  | 'Companion: Not running'
  | 'Companion: Incompatible'
  | 'Companion: Unavailable';

export interface CompanionStatusClient {
  connect(): Promise<void>;
  companionStatus(): ReturnType<CompanionClient['companionStatus']>;
  disconnect(): void;
  dispose(): void;
}

/** A snapshot from one bounded IPC exchange. Only explicit refresh starts another. */
export function createCompanionStatusProjection(
  client: CompanionStatusClient,
  render: (text: CompanionStatusText) => void,
): { probe(): Promise<void>; dispose(): void } {
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  render('Companion: Checking');

  const probe = (): Promise<void> => {
    if (disposed) { return Promise.resolve(); }
    if (inFlight) { return inFlight; }
    render('Companion: Checking');
    const attempt = (async () => {
      try {
        await client.connect();
        if (disposed) { return; }
        const status = await client.companionStatus();
        if (!disposed) {
          render(status.state === 'ready' ? 'Companion: Connected (last check)' : 'Companion: Unavailable');
        }
      } catch (error) {
        client.disconnect();
        if (!disposed) {
          render(error instanceof CompanionClientError
            ? error.code === 'unavailable' ? 'Companion: Not running'
              : error.code === 'incompatible_protocol' || error.code === 'protocol_violation'
                || error.code === 'remote_protocol_error' ? 'Companion: Incompatible'
                : 'Companion: Unavailable'
            : 'Companion: Unavailable');
        }
      }
    })();
    inFlight = attempt;
    void attempt.finally(() => {
      if (inFlight === attempt) { inFlight = undefined; }
    });
    return attempt;
  };

  return {
    probe,
    dispose: () => {
      disposed = true;
      client.dispose();
    },
  };
}
