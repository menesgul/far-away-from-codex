/** Negotiation vocabulary only; concrete IPC messages belong to a later slice. */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** Wire DTOs must be representable as JSON, separate from canonical domain state. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
