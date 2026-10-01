export const MAX_REQUEST_BODY_BYTES = 16 * 1024;
export const REQUEST_BODY_READ_TIMEOUT_MS = 5_000;
export const MAX_REQUEST_URL_LENGTH = 2_048;

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

interface ErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  additionalHeaders?: HeadersInit,
): Response {
  const payload: ErrorPayload = {
    error: { code, message },
  };

  const response = jsonResponse(payload, status);
  if (additionalHeaders !== undefined) {
    for (const [name, value] of new Headers(additionalHeaders)) {
      response.headers.set(name, value);
    }
  }

  return response;
}

class RequestBodyReadTimeoutError extends Error {
  public constructor() {
    super("Request body read timed out.");
    this.name = "RequestBodyReadTimeoutError";
  }
}

export async function enforceRequestBounds(
  request: Request,
  bodyReadTimeoutMs = REQUEST_BODY_READ_TIMEOUT_MS,
): Promise<Response | undefined> {
  if (request.url.length > MAX_REQUEST_URL_LENGTH) {
    return errorResponse(414, "REQUEST_URI_TOO_LONG", "Request URI is too long.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return errorResponse(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    }

    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      return errorResponse(413, "REQUEST_BODY_TOO_LARGE", "Request body is too large.");
    }
  }

  if (request.body === null) {
    return undefined;
  }

  let inspectionRequest: Request;
  try {
    inspectionRequest = request.clone();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body could not be read.");
  }

  const reader = inspectionRequest.body!.getReader();
  let bytesRead = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const readDeadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new RequestBodyReadTimeoutError()),
      bodyReadTimeoutMs,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), readDeadline]);
      if (done) {
        return undefined;
      }

      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return errorResponse(413, "REQUEST_BODY_TOO_LARGE", "Request body is too large.");
      }
    }
  } catch (error) {
    if (error instanceof RequestBodyReadTimeoutError) {
      void reader.cancel().catch(() => undefined);
      return errorResponse(408, "REQUEST_BODY_TIMEOUT", "Request body could not be read in time.");
    }

    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body could not be read.");
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    reader.releaseLock();
  }
}
