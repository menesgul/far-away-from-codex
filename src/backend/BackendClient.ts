export class BackendClientError extends Error {}

export interface InstallationCredentialStore {
	getInstallationCredential(): Promise<string | undefined>;
	saveInstallationCredential(credential: string): Promise<void>;
	deleteInstallationCredential(): Promise<void>;
}

interface RegistrationResponse {
	installationCredential?: unknown;
}

const MAX_RESPONSE_BODY_BYTES = 8 * 1024;
const MIN_INSTALLATION_CREDENTIAL_LENGTH = 32;
const MAX_INSTALLATION_CREDENTIAL_LENGTH = 128;

export class BackendClient {
	private registrationInFlight: Promise<string> | undefined;
	private readonly baseUrl: URL;

	public constructor(
		baseUrl: string,
		private readonly timeoutMs = 10_000,
		private readonly request: typeof fetch = fetch
	) {
		this.baseUrl = this.parseBaseUrl(baseUrl);
	}

	public async ensureInstallation(store: InstallationCredentialStore): Promise<string> {
		const existingCredential = await store.getInstallationCredential();
		if (this.isValidCredential(existingCredential)) {
			return existingCredential;
		}

		if (this.registrationInFlight === undefined) {
			this.registrationInFlight = this.registerAndStoreInstallation(store);
		}

		try {
			return await this.registrationInFlight;
		} finally {
			this.registrationInFlight = undefined;
		}
	}

	public async resetInstallation(store: InstallationCredentialStore): Promise<void> {
		const credential = await store.getInstallationCredential();
		if (!this.isValidCredential(credential)) {
			throw new BackendClientError('No anonymous installation is registered.');
		}

		try {
			await this.executeRequest(
				'/v1/installation',
				{
					method: 'DELETE',
					headers: { Authorization: `Bearer ${credential}` },
				},
				async (response) => {
					if (response.status !== 204) {
						throw this.errorForStatus(response.status);
					}
				}
			);
		} finally {
			// A lost DELETE response may mean the backend already revoked this credential.
			await store.deleteInstallationCredential();
		}
	}

	private async registerAndStoreInstallation(store: InstallationCredentialStore): Promise<string> {
		const credential = await this.executeRequest(
			'/v1/installations',
			{ method: 'POST' },
			async (response) => {
				if (response.status !== 201) {
					throw this.errorForStatus(response.status);
				}

				const result = await this.readBoundedJson(response);
				if (!this.isRegistrationResponse(result)) {
					throw new BackendClientError('The backend returned an invalid registration response.');
				}

				return result.installationCredential;
			}
		);

		await store.saveInstallationCredential(credential);
		return credential;
	}

	private async executeRequest<T>(
		path: string,
		init: RequestInit,
		consumeResponse: (response: Response) => Promise<T>
	): Promise<T> {
		if (this.baseUrl.hostname.endsWith('.invalid')) {
			throw new BackendClientError('The Far Away From Codex backend is not configured.');
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await this.request(new URL(path, this.baseUrl), {
				...init,
				signal: controller.signal,
			});
			return await consumeResponse(response);
		} catch (error) {
			if (error instanceof BackendClientError) {
				throw error;
			}

			if (controller.signal.aborted) {
				throw new BackendClientError('The backend request timed out.');
			}

			throw new BackendClientError('Could not reach the Far Away From Codex backend.');
		} finally {
			clearTimeout(timeout);
		}
	}

	private async readBoundedJson(response: Response): Promise<unknown> {
		if (response.body === null) {
			throw new BackendClientError('The backend returned an invalid registration response.');
		}

		const contentLength = response.headers.get('content-length');
		if (contentLength !== null) {
			const parsedLength = Number(contentLength);
			if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
				throw new BackendClientError('The backend returned an invalid response.');
			}

			if (parsedLength > MAX_RESPONSE_BODY_BYTES) {
				throw new BackendClientError('The backend response was too large.');
			}
		}

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				totalBytes += value.byteLength;
				if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
					await reader.cancel();
					throw new BackendClientError('The backend response was too large.');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}

		const body = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}

		try {
			return JSON.parse(new TextDecoder().decode(body));
		} catch {
			throw new BackendClientError('The backend returned an invalid registration response.');
		}
	}

	private errorForStatus(status: number): BackendClientError {
		if (status === 401) {
			return new BackendClientError('The anonymous installation credential was rejected.');
		}

		if (status === 429) {
			return new BackendClientError('Too many backend requests. Please try again later.');
		}

		if (status >= 500) {
			return new BackendClientError('The Far Away From Codex backend is unavailable.');
		}

		return new BackendClientError('The backend request was rejected.');
	}

	private isValidCredential(value: unknown): value is string {
		return typeof value === 'string'
			&& value.length >= MIN_INSTALLATION_CREDENTIAL_LENGTH
			&& value.length <= MAX_INSTALLATION_CREDENTIAL_LENGTH
			&& /^[A-Za-z0-9_-]+$/.test(value);
	}

	private isRegistrationResponse(value: unknown): value is RegistrationResponse & {
		installationCredential: string;
	} {
		return typeof value === 'object'
			&& value !== null
			&& this.isValidCredential((value as RegistrationResponse).installationCredential);
	}

	private parseBaseUrl(value: string): URL {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new BackendClientError('The backend URL is invalid.');
		}

		const isLocalDevelopment = url.protocol === 'http:'
			&& (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
		if ((url.protocol !== 'https:' && !isLocalDevelopment)
			|| url.username !== ''
			|| url.password !== ''
			|| url.search !== ''
			|| url.hash !== '') {
			throw new BackendClientError('The backend URL is invalid.');
		}

		return new URL('/', url);
	}
}
