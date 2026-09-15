import * as vscode from 'vscode';

const INSTALLATION_CREDENTIAL_KEY = 'farAway.installationCredential';

export class SecretStore {
	public constructor(private readonly secretStorage: vscode.SecretStorage) {}

	public async saveInstallationCredential(credential: string): Promise<void> {
		await this.secretStorage.store(INSTALLATION_CREDENTIAL_KEY, credential);
	}

	public async getInstallationCredential(): Promise<string | undefined> {
		return this.secretStorage.get(INSTALLATION_CREDENTIAL_KEY);
	}

	public async deleteInstallationCredential(): Promise<void> {
		await this.secretStorage.delete(INSTALLATION_CREDENTIAL_KEY);
	}
}
