/** Far Away IDs never share a type with opaque source/runtime IDs. */
export type AgentId = string & { readonly __brand: 'AgentId' };
export type SessionKey = string & { readonly __brand: 'SessionKey' };
export type InteractionId = string & { readonly __brand: 'InteractionId' };
export type AttentionEventId = string & { readonly __brand: 'AttentionEventId' };
export type AuthorityGeneration = string & { readonly __brand: 'AuthorityGeneration' };
export type SourceRuntimeId = string & { readonly __brand: 'SourceRuntimeId' };
export type SourceSessionId = string & { readonly __brand: 'SourceSessionId' };
export type SourceRequestId = string & { readonly __brand: 'SourceRequestId' };

export interface AgentDescriptor {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly version?: string;
}

/** Describes an integration setting; it is not a live runtime or authority claim. */
export interface RuntimeTopology {
  readonly topologyId: string;
  readonly description: string;
}

/** Opaque source identity is always scoped to its source runtime. */
export interface SourceSessionRef {
  readonly runtimeId: SourceRuntimeId;
  readonly sessionId: SourceSessionId;
}

export interface SourceRequestRef {
  readonly sourceSession: SourceSessionRef;
  readonly requestId: SourceRequestId;
}

export type SessionLifecycle = 'active' | 'ended' | 'unknown';
export type SessionAttachment = 'attached' | 'detached' | 'unknown';

export interface AgentSession {
  readonly sessionKey: SessionKey;
  readonly agentId: AgentId;
  readonly topologyId: RuntimeTopology['topologyId'];
  readonly sourceSession: SourceSessionRef;
  readonly lifecycle: SessionLifecycle;
  readonly attachment: SessionAttachment;
}

/** The source-defined response set. Short text is allowed only within its bound. */
export type AllowedResponse =
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'choice'; readonly choiceId: string; readonly label: string }
  | { readonly kind: 'shortText'; readonly maxLength: number };

/** A selected response must be checked against the current AllowedResponse set. */
export type BoundedResponse =
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'choice'; readonly choiceId: string }
  | { readonly kind: 'shortText'; readonly text: string };

interface InteractionCorrelation {
  readonly interactionId: InteractionId;
  readonly sessionKey: SessionKey;
  readonly sourceRequest: SourceRequestRef;
  readonly authorityGeneration: AuthorityGeneration;
  readonly observedAt: string;
}

/** Terminal variants do not carry an actionable response set. */
export type PendingInteraction =
  | (InteractionCorrelation & {
      readonly status: 'pending';
      readonly allowedResponses: readonly AllowedResponse[];
      readonly expiresAt?: string;
    })
  | (InteractionCorrelation & {
      readonly status: 'terminal';
      readonly outcome: 'resolved' | 'cancelled' | 'expired' | 'stale';
      readonly endedAt: string;
    });

/** Canonical attention facts have no delivery or presentation state. */
export interface AttentionEvent {
  readonly eventId: AttentionEventId;
  readonly sessionKey: SessionKey;
  readonly interactionId?: InteractionId;
  readonly class: 'needsYou' | 'outcome' | 'meaningfulProgress';
  readonly occurredAt: string;
  readonly summary: string;
}

export type AdapterCapability = 'discovery' | 'observation' | 'resolution';

/** Capability is evidence of a mechanism, never proof of current authority. */
export interface CapabilityProfile {
  readonly agentId: AgentId;
  readonly topologyId: RuntimeTopology['topologyId'];
  readonly agentVersion: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly evidence: readonly string[];
}

export type SupportLevel = 'Interactive' | 'Monitor' | 'Experimental' | 'Unsupported';

export interface SupportProfile {
  readonly agentId: AgentId;
  readonly topologyId: RuntimeTopology['topologyId'];
  readonly agentVersion: string;
  readonly level: SupportLevel;
  readonly evidence: readonly string[];
}

/** A persisted binding is a record, not live authority after restart. */
export interface AuthorityBinding {
  readonly sessionKey: SessionKey;
  readonly sourceSession: SourceSessionRef;
  readonly generation: AuthorityGeneration;
  readonly establishedAt: string;
}
