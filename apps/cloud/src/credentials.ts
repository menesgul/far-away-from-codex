const INSTALLATION_CREDENTIAL_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateInstallationCredential(): string {
  const randomBytes = new Uint8Array(INSTALLATION_CREDENTIAL_BYTES);
  crypto.getRandomValues(randomBytes);
  return toBase64Url(randomBytes);
}

export async function hashInstallationCredential(credential: string): Promise<string> {
  const encodedCredential = new TextEncoder().encode(credential);
  const digest = await crypto.subtle.digest("SHA-256", encodedCredential);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
