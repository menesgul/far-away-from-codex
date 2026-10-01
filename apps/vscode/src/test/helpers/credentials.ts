import { type InstallationCredentialStore } from '../../backend/BackendClient';

export const INSTALLATION_CREDENTIAL = 'abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF';

export class FakeCredentialStore implements InstallationCredentialStore {
	public constructor(public credential?: string) {}

	public async getInstallationCredential(): Promise<string | undefined> {
		return this.credential;
	}

	public async saveInstallationCredential(credential: string): Promise<void> {
		this.credential = credential;
	}

	public async deleteInstallationCredential(): Promise<void> {
		this.credential = undefined;
	}
}
