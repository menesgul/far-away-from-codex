import type {
  ResolutionInput,
  SourceObservation,
} from '../src/index.js';
import type {
  AuthorityBinding,
  SourceRequestRef,
  SourceSessionRef,
} from '@far-away/domain';

declare const sourceRequest: SourceRequestRef;
declare const sourceSession: SourceSessionRef;
declare const authority: AuthorityBinding;

const request: SourceObservation = {
  kind: 'humanInputRequested',
  sourceRequest,
  allowedResponses: [{ kind: 'approve' }, { kind: 'reject' }],
  observedAt: '',
};

if (request.kind === 'humanInputRequested') {
  const exactRequest: SourceRequestRef = request.sourceRequest;
  const sourceDefinedResponses = request.allowedResponses;
  void exactRequest;
  void sourceDefinedResponses;
}

// @ts-expect-error A request cannot omit the source-defined response set.
const missingResponseSet: SourceObservation = {
  kind: 'humanInputRequested',
  sourceRequest,
  observedAt: '',
};
void missingResponseSet;

// @ts-expect-error A human-input request needs an exact SourceRequestRef.
const missingSourceRequest: SourceObservation = {
  kind: 'humanInputRequested',
  allowedResponses: [{ kind: 'approve' }],
  observedAt: '',
};
void missingSourceRequest;

const progress: SourceObservation = {
  kind: 'progress',
  sourceSession,
  observedAt: '',
};
void progress;

const resolution: ResolutionInput = {
  sourceRequest,
  authority,
  allowedResponse: { kind: 'approve' },
  response: { kind: 'approve' },
};
void resolution;

// @ts-expect-error Resolution must carry the source-defined allowed response.
const missingAllowance: ResolutionInput = {
  sourceRequest,
  authority,
  response: { kind: 'approve' },
};
void missingAllowance;
