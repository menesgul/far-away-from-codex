import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../extension';
import { CompanionClient, CompanionClientError } from '../companion/CompanionClient';
import { Deferred, settlePromises } from './helpers/async';

const manifestPath = path.resolve(__dirname, '../../package.json');

function fakeActivation(connect: () => Promise<void>) {
	const subscriptions: vscode.Disposable[] = [];
	const commands = new Map<string, () => unknown>();
	const statusItems: Array<{ text: string; command?: string; disposed: boolean; shown: boolean }> = [];
	let clientCreations = 0;
	let connectCalls = 0;
	let statusReads = 0;
	let clientDisposals = 0;
	let legacyCreations = 0;
	let legacyDisposals = 0;
	const legacyCalls: string[] = [];
	const context = {
		subscriptions,
		get secrets() { throw new Error('Companion-only activation read Telegram secrets'); },
		get globalState() { throw new Error('Companion-only activation read onboarding state'); },
		get workspaceState() { throw new Error('Companion-only activation read workspace state'); },
	} as unknown as vscode.ExtensionContext;
	activate(context, {
		createCompanionClient: () => {
			clientCreations += 1;
			return {
				connect: () => { connectCalls += 1; return connect(); },
				companionStatus: async () => {
					statusReads += 1;
					return { state: 'ready', transport: process.platform === 'win32'
						? 'named-pipe' as const : 'unix-domain-socket' as const,
						protocol: { major: 1 as const, minor: 0 as const } };
				},
				disconnect: () => undefined,
				dispose: () => { clientDisposals += 1; },
			};
		},
		createLegacyTelegramRuntime: () => {
			legacyCreations += 1;
			return {
				toggleAlerts: async () => { legacyCalls.push('toggle'); },
				connectTelegram: async () => { legacyCalls.push('connect'); },
				disconnectTelegram: async () => { legacyCalls.push('disconnect'); },
				dispose: () => { legacyDisposals += 1; },
			};
		},
		createStatusBarItem: () => {
			const item = { text: '', command: undefined, disposed: false, shown: false,
				show() { this.shown = true; }, dispose() { this.disposed = true; } };
			statusItems.push(item);
			return item as unknown as vscode.StatusBarItem;
		},
		registerCommand: (name, callback) => {
			commands.set(name, callback);
			return { dispose: () => { commands.delete(name); } };
		},
	});
	return {
		subscriptions, commands, statusItems, legacyCalls,
		get clientCreations() { return clientCreations; },
		get connectCalls() { return connectCalls; },
		get statusReads() { return statusReads; },
		get clientDisposals() { return clientDisposals; },
		get legacyCreations() { return legacyCreations; },
		get legacyDisposals() { return legacyDisposals; },
		dispose: () => subscriptions.forEach((item) => item.dispose()),
	};
}

suite('M0.9 activation', () => {
	test('invalid Companion locator cannot prevent any command registration', async () => {
		const subscriptions: vscode.Disposable[] = [];
		const commands = new Map<string, () => unknown>();
		const items: Array<{ text: string; disposed: boolean }> = [];
		const context = { subscriptions } as unknown as vscode.ExtensionContext;
		assert.doesNotThrow(() => activate(context, {
			createCompanionClient: () => new CompanionClient({
				paths: { platform: 'win32', localAppData: '' },
			}),
			createLegacyTelegramRuntime: () => ({
				toggleAlerts: async () => undefined,
				connectTelegram: async () => undefined,
				disconnectTelegram: async () => undefined,
				dispose: () => undefined,
			}),
			createStatusBarItem: () => {
				const item = { text: '', disposed: false, show() {}, dispose() { this.disposed = true; } };
				items.push(item);
				return item as unknown as vscode.StatusBarItem;
			},
			registerCommand: (name, callback) => {
				commands.set(name, callback);
				return { dispose: () => { commands.delete(name); } };
			},
		}));
		assert.strictEqual(commands.size, 5);
		assert.deepStrictEqual([...commands.keys()], [
			'far-away-from-codex.refreshCompanionStatus',
			'far-away-from-codex.toggleAlerts',
			'far-away-from-codex.connectTelegram',
			'far-away-from-codex.disconnectTelegram',
			'far-away-from-codex.testNotification',
		]);
		await settlePromises();
		assert.strictEqual(items[0].text, 'Companion: Unavailable');
		for (const disposable of subscriptions) { disposable.dispose(); }
		assert.strictEqual(items[0].disposed, true);
	});

	test('partial command registration failure disposes the Companion status item', () => {
		const subscriptions: vscode.Disposable[] = [];
		const items: Array<{ disposed: boolean }> = [];
		const registrations: Array<{ disposed: boolean; dispose(): void }> = [];
		assert.throws(() => activate({ subscriptions } as unknown as vscode.ExtensionContext, {
			createStatusBarItem: () => {
				const item = { disposed: false, show() {}, dispose() { this.disposed = true; } };
				items.push(item);
				return item as unknown as vscode.StatusBarItem;
			},
			registerCommand: () => {
				if (registrations.length === 2) { throw new Error('registration failed'); }
				const registration = { disposed: false, dispose() { this.disposed = true; } };
				registrations.push(registration);
				return registration;
			},
		}), /registration failed/);
		assert.strictEqual(items[0].disposed, true);
		assert.ok(registrations.every((item) => item.disposed));
		assert.strictEqual(subscriptions.length, 0);
	});

	test('disposing activation during the initial probe prevents a late status mutation', async () => {
		const gate = new Deferred<void>();
		const h = fakeActivation(() => gate.promise);
		await settlePromises();
		assert.strictEqual(h.connectCalls, 1);
		h.dispose();
		const priorText = h.statusItems[0].text;
		gate.resolve();
		await settlePromises();
		assert.strictEqual(h.statusItems[0].text, priorText);
		assert.strictEqual(h.statusReads, 0);
		assert.strictEqual(h.clientDisposals, 1);
		assert.strictEqual(h.statusItems[0].disposed, true);
	});

	test('concurrent first Telegram commands construct one legacy runtime', async () => {
		const h = fakeActivation(async () => undefined);
		try {
			await Promise.all([
				h.commands.get('far-away-from-codex.connectTelegram')?.(),
				h.commands.get('far-away-from-codex.disconnectTelegram')?.(),
				h.commands.get('far-away-from-codex.toggleAlerts')?.(),
			]);
			assert.strictEqual(h.legacyCreations, 1);
			assert.deepStrictEqual(h.legacyCalls, ['connect', 'disconnect', 'toggle']);
		} finally { h.dispose(); }
	});

	test('a contributed command activates from a genuinely inactive pinned host when available', async function () {
		const extension = vscode.extensions.all.find((entry) => entry.packageJSON.name === 'far-away-from-codex');
		assert.ok(extension);
		if (extension.isActive) { this.skip(); }
		await vscode.commands.executeCommand('far-away-from-codex.refreshCompanionStatus');
		assert.strictEqual(extension.isActive, true);
	});
	test('manifest activates through contributed commands on pinned VS Code', async () => {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
			activationEvents?: string[];
			contributes: { commands: Array<{ command: string }> };
		};
		assert.deepStrictEqual(manifest.activationEvents ?? [], []);
		const expected = [
			'refreshCompanionStatus', 'toggleAlerts', 'connectTelegram',
			'disconnectTelegram', 'testNotification',
		].map((name) => `far-away-from-codex.${name}`);
		assert.deepStrictEqual(
			new Set(manifest.contributes.commands.map(({ command }) => command)), new Set(expected),
		);
		await vscode.commands.executeCommand(expected[0]);
		const extension = vscode.extensions.all.find((entry) => entry.packageJSON.name === 'far-away-from-codex');
		assert.ok(extension?.isActive, 'contributed command must activate the extension');
		const registered = await vscode.commands.getCommands(true);
		for (const command of expected) { assert.ok(registered.includes(command), command); }
	});

	test('activation synchronously registers surfaces while IPC is unresolved and Telegram stays lazy', async () => {
		const gate = new Deferred<void>();
		const h = fakeActivation(() => gate.promise);
		try {
			assert.strictEqual(h.commands.size, 5);
			assert.strictEqual(h.clientCreations, 0);
			assert.strictEqual(h.connectCalls, 0);
			assert.strictEqual(h.legacyCreations, 0);
			assert.strictEqual(h.statusItems[0].shown, true);
			await settlePromises();
			assert.strictEqual(h.connectCalls, 1);
			assert.strictEqual(h.statusReads, 0);
			assert.strictEqual(h.legacyCreations, 0);
			gate.resolve();
			await settlePromises();
			assert.strictEqual(h.statusReads, 1);
			assert.strictEqual(h.statusItems[0].text, 'Companion: Connected (last check)');
		} finally { h.dispose(); }
		assert.strictEqual(h.clientDisposals, 1);
		assert.strictEqual(h.legacyDisposals, 0);
		assert.strictEqual(h.statusItems[0].disposed, true);
	});

	test('absence leaves commands usable and only explicit refresh makes one more connection', async () => {
		const h = fakeActivation(async () => { throw new CompanionClientError('unavailable'); });
		try {
			await settlePromises();
			assert.strictEqual(h.statusItems[0].text, 'Companion: Not running');
			assert.strictEqual(h.connectCalls, 1);
			assert.strictEqual(h.legacyCreations, 0);
			await h.commands.get('far-away-from-codex.refreshCompanionStatus')?.();
			assert.strictEqual(h.connectCalls, 2);
			await settlePromises();
			assert.strictEqual(h.connectCalls, 2);
			await h.commands.get('far-away-from-codex.connectTelegram')?.();
			await h.commands.get('far-away-from-codex.disconnectTelegram')?.();
			await h.commands.get('far-away-from-codex.toggleAlerts')?.();
			assert.strictEqual(h.legacyCreations, 1);
			assert.deepStrictEqual(h.legacyCalls, ['connect', 'disconnect', 'toggle']);
		} finally { h.dispose(); }
		assert.strictEqual(h.legacyDisposals, 1);
	});

	test('protocol incompatibility fails closed without losing Telegram commands', async () => {
		const h = fakeActivation(async () => { throw new CompanionClientError('incompatible_protocol'); });
		try {
			await settlePromises();
			assert.strictEqual(h.statusItems[0].text, 'Companion: Incompatible');
			assert.strictEqual(h.statusReads, 0);
			assert.strictEqual(h.commands.size, 5);
			assert.strictEqual(h.legacyCreations, 0);
			await h.commands.get('far-away-from-codex.connectTelegram')?.();
			assert.deepStrictEqual(h.legacyCalls, ['connect']);
		} finally { h.dispose(); }
	});

	test('Companion-only dispatch uses one IPC probe without legacy state or background retries', async () => {
		const h = fakeActivation(async () => undefined);
		try {
			assert.strictEqual(h.commands.size, 5);
			assert.strictEqual(h.statusItems[0].command, 'far-away-from-codex.refreshCompanionStatus');
			assert.strictEqual(h.clientCreations, 0);
			assert.strictEqual(h.legacyCreations, 0);
			await settlePromises();
			assert.strictEqual(h.clientCreations, 1);
			assert.strictEqual(h.connectCalls, 1);
			assert.strictEqual(h.statusReads, 1);
			assert.strictEqual(h.legacyCreations, 0);
			await settlePromises();
			assert.strictEqual(h.connectCalls, 1);
			assert.strictEqual(h.legacyCreations, 0);
		} finally { h.dispose(); }
	});
});
