import { errorResponse } from "./http";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

export const PAIRING_CREATION_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
export const PAIRING_STATUS_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

interface PairingRateLimitOptions {
  unavailableCode: string;
  unavailableMessage: string;
  limitedCode: string;
  limitedMessage: string;
  retryAfterSeconds: number;
}

export async function enforceInstallationRateLimit(
  installationId: string,
  rateLimiter: RateLimit,
  options: PairingRateLimitOptions,
  dependencyTimeoutMs = WORKER_DEPENDENCY_TIMEOUT_MS,
): Promise<Response | undefined> {
  try {
    const outcome = await withTimeout(rateLimiter.limit({ key: installationId }), dependencyTimeoutMs);
    if (outcome.success) {
      return undefined;
    }

    return errorResponse(429, options.limitedCode, options.limitedMessage, {
      "Retry-After": String(options.retryAfterSeconds),
    });
  } catch {
    return errorResponse(503, options.unavailableCode, options.unavailableMessage);
  }
}

export const pairingCreationRateLimitOptions: PairingRateLimitOptions = {
  unavailableCode: "PAIRING_UNAVAILABLE",
  unavailableMessage: "Pairing is temporarily unavailable. Please try again later.",
  limitedCode: "PAIRING_RATE_LIMITED",
  limitedMessage: "Too many pairing requests. Please try again later.",
  retryAfterSeconds: PAIRING_CREATION_RATE_LIMIT_RETRY_AFTER_SECONDS,
};

export const pairingStatusRateLimitOptions: PairingRateLimitOptions = {
  unavailableCode: "PAIRING_STATUS_UNAVAILABLE",
  unavailableMessage: "Pairing status is temporarily unavailable. Please try again later.",
  limitedCode: "PAIRING_STATUS_RATE_LIMITED",
  limitedMessage: "Too many pairing status requests. Please try again later.",
  retryAfterSeconds: PAIRING_STATUS_RATE_LIMIT_RETRY_AFTER_SECONDS,
};
