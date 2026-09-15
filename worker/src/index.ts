import { hasRequiredConfiguration } from "./config";
import type { Env } from "./env";
import { enforceRequestBounds, errorResponse, jsonResponse } from "./http";
import { registerInstallation, revokeInstallation } from "./installations";
import { enforceRegistrationRateLimit } from "./registrationRateLimit";
import { withTimeout } from "./timeout";

const D1_HEALTH_TIMEOUT_MS = 2_000;

async function healthResponse(env: Partial<Env>): Promise<Response> {
  if (!hasRequiredConfiguration(env)) {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "Worker configuration is incomplete.");
  }

  try {
    await withTimeout(env.DB.prepare("SELECT 1 AS ok").first(), D1_HEALTH_TIMEOUT_MS);
    return jsonResponse({ ok: true });
  } catch {
    return errorResponse(503, "SERVICE_UNAVAILABLE", "Worker dependency is unavailable.");
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const boundsError = await enforceRequestBounds(request);
  if (boundsError !== undefined) {
    return boundsError;
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "Request URL is invalid.");
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    }

    return healthResponse(env);
  }

  if (url.pathname === "/v1/installations") {
    if (request.method !== "POST") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    }

    if (!hasRequiredConfiguration(env)) {
      return errorResponse(503, "SERVICE_UNAVAILABLE", "Worker configuration is incomplete.");
    }

    const rateLimitResponse = await enforceRegistrationRateLimit(
      request,
      env.REGISTRATION_RATE_LIMITER,
    );
    if (rateLimitResponse !== undefined) {
      return rateLimitResponse;
    }

    return registerInstallation(env);
  }

  if (url.pathname === "/v1/installation") {
    if (request.method !== "DELETE") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    }

    return revokeInstallation(request, env);
  }

  return errorResponse(404, "NOT_FOUND", "Route not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch {
      return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred.");
    }
  },
} satisfies ExportedHandler<Env>;
