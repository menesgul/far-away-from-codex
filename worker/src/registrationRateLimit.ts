import { errorResponse } from "./http";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

export const REGISTRATION_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export async function enforceRegistrationRateLimit(
  request: Request,
  rateLimiter: RateLimit,
  dependencyTimeoutMs = WORKER_DEPENDENCY_TIMEOUT_MS,
): Promise<Response | undefined> {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "missing-client-ip";

  try {
    const outcome = await withTimeout(rateLimiter.limit({ key: clientIp }), dependencyTimeoutMs);
    if (outcome.success) {
      return undefined;
    }

    return errorResponse(
      429,
      "REGISTRATION_RATE_LIMITED",
      "Too many registration requests. Please try again later.",
      { "Retry-After": String(REGISTRATION_RATE_LIMIT_RETRY_AFTER_SECONDS) },
    );
  } catch {
    return errorResponse(
      503,
      "REGISTRATION_UNAVAILABLE",
      "Registration is temporarily unavailable. Please try again later.",
    );
  }
}
