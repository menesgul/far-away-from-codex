import { hashInstallationCredential } from "./credentials";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

const BEARER_CREDENTIAL_PATTERN = /^Bearer ([A-Za-z0-9_-]{32,128})$/i;

export interface AuthenticatedInstallation {
  id: string;
}

export type AuthenticationResult =
  | { authenticated: true; installation: AuthenticatedInstallation }
  | { authenticated: false };

interface InstallationRow {
  id: string;
}

export async function authenticateInstallation(
  request: Request,
  database: D1Database,
  databaseTimeoutMs = WORKER_DEPENDENCY_TIMEOUT_MS,
): Promise<AuthenticationResult> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(BEARER_CREDENTIAL_PATTERN);
  if (match === undefined || match === null) {
    return { authenticated: false };
  }

  const credentialHash = await hashInstallationCredential(match[1]);
  const installation = await withTimeout(
    database
      .prepare(
        "SELECT id FROM installations WHERE credential_hash = ? AND revoked_at IS NULL LIMIT 1",
      )
      .bind(credentialHash)
      .first<InstallationRow>(),
    databaseTimeoutMs,
  );

  if (installation === null) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    installation: { id: installation.id },
  };
}
