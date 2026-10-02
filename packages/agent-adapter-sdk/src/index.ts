import type {
  AgentDescriptor,
  AllowedResponse,
  AuthorityBinding,
  BoundedResponse,
  RuntimeTopology,
  SessionLifecycle,
  SourceRequestRef,
  SourceRuntimeId,
  SourceSessionRef,
} from '@far-away/domain';

/** Discovery only reports source evidence. It cannot establish live authority. */
export interface DiscoveredRuntime {
  readonly runtimeId: SourceRuntimeId;
  readonly topology: RuntimeTopology;
  readonly sessions: readonly SourceSessionRef[];
  readonly evidence: readonly string[];
  readonly observedAt: string;
}

export interface DiscoveryPort {
  discover(): Promise<readonly DiscoveredRuntime[]>;
}

/** Typed source facts remain observations until Companion canonicalizes them. */
interface ObservationEvidence {
  readonly observedAt: string;
  /** Optional diagnostics; canonicalization uses the typed event fields. */
  readonly evidence?: readonly string[];
}

export type SourceObservation = ObservationEvidence & (
  | {
      readonly kind: 'humanInputRequested';
      readonly sourceRequest: SourceRequestRef;
      readonly allowedResponses: readonly [AllowedResponse, ...AllowedResponse[]];
    }
  | {
      readonly kind: 'requestClosed';
      readonly sourceRequest: SourceRequestRef;
      readonly reason?: 'resolved' | 'cancelled' | 'expired';
    }
  | {
      readonly kind: 'sessionLifecycle';
      readonly sourceSession: SourceSessionRef;
      readonly lifecycle: SessionLifecycle;
    }
  | {
      readonly kind: 'progress';
      readonly sourceSession: SourceSessionRef;
    }
  | {
      readonly kind: 'outcome';
      readonly sourceSession: SourceSessionRef;
      readonly outcome: 'succeeded' | 'failed' | 'cancelled';
    }
);

export interface ObservationPort {
  observe(sourceSession: SourceSessionRef): AsyncIterable<SourceObservation>;
}

/** Companion must revalidate current correlation, authority and allowance first. */
export interface ResolutionInput {
  readonly sourceRequest: SourceRequestRef;
  readonly authority: AuthorityBinding;
  /** The source-defined option or text bound selected from the current request. */
  readonly allowedResponse: AllowedResponse;
  readonly response: BoundedResponse;
}

/** Unknown source effect is never an instruction to retry blindly. */
export type ResolutionOutcome =
  | { readonly status: 'sourceConfirmed' }
  | { readonly status: 'rejected' }
  | { readonly status: 'stale' }
  | { readonly status: 'notAuthoritative' }
  | { readonly status: 'unknown' };

export interface ResolutionPort {
  resolve(input: ResolutionInput): Promise<ResolutionOutcome>;
}

/** Ports are independent: an integration may support any subset. */
export interface AgentAdapter {
  readonly agent: AgentDescriptor;
  readonly discovery?: DiscoveryPort;
  readonly observation?: ObservationPort;
  readonly resolution?: ResolutionPort;
}
