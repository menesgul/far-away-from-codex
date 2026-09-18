import * as vscode from 'vscode';
import { SecretStore } from '../../state/SecretStore';
import { INSTALLATION_CREDENTIAL } from '../helpers/credentials';
import * as assert from 'assert';

suite('SecretStore', () => {
	test('SecretStore persists only the anonymous installation credential key', async () => {
		const storedValues = new Map<string, string>();
		const storage = {
			get: async (key: string) => storedValues.get(key),
			store: async (key: string, value: string) => {
				storedValues.set(key, value);
			},
			delete: async (key: string) => {
				storedValues.delete(key);
			},
		} as unknown as vscode.SecretStorage;
		const store = new SecretStore(storage);

		await store.saveInstallationCredential(INSTALLATION_CREDENTIAL);

		assert.strictEqual(await store.getInstallationCredential(), INSTALLATION_CREDENTIAL);
		assert.deepStrictEqual([...storedValues.keys()], ['farAway.installationCredential']);
		assert.strictEqual(storedValues.has(['telegram', 'botToken'].join('.')), false);
		assert.strictEqual(storedValues.has(['telegram', 'chatId'].join('.')), false);
	});
});
