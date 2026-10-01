import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { TELEGRAM_ONBOARDING_SHOWN_KEY } from '../telegram/TelegramOnboarding';

function readTypeScriptFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'test') {
				return [];
			}

			return readTypeScriptFiles(entryPath);
		}

		return entry.name.endsWith('.ts') ? [entryPath] : [];
	});
}

suite('Extension Test Suite', () => {
	test('extension source contains no direct Telegram API or client credential path', () => {
		const sourceRoot = path.resolve(__dirname, '../../src');
		const sourceFiles = readTypeScriptFiles(sourceRoot);
		const combinedSource = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

		assert.strictEqual(sourceFiles.some((file) => file.endsWith(`Telegram${'Client.ts'}`)), false);
		assert.strictEqual(combinedSource.includes(['api', 'telegram', 'org'].join('.')), false);
		assert.strictEqual(combinedSource.includes(['telegram', 'botToken'].join('.')), false);
		assert.strictEqual(combinedSource.includes(['telegram', 'chatId'].join('.')), false);
	});

	test('extension contributes Telegram connection commands and delegates pairing lifecycle to one session', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
			contributes?: {
				commands?: Array<{ command?: string }>;
				configuration?: { properties?: Record<string, unknown> };
			};
		};
		const commands = packageJson.contributes?.commands?.map((command) => command.command) ?? [];
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
		const connectSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramConnectCommand.ts'), 'utf8');
		const refreshSource = fs.readFileSync(path.resolve(__dirname, '../../src/state/TelegramConnectionStateRefresh.ts'), 'utf8');
		const onboardingSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramOnboarding.ts'), 'utf8');
		const toggleSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramAlertsToggleCommand.ts'), 'utf8');

		assert.ok(commands.includes('far-away-from-codex.connectTelegram'));
		assert.ok(commands.includes('far-away-from-codex.disconnectTelegram'));
		const sessionSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramPairingSession.ts'), 'utf8');
		assert.ok(extensionSource.includes('createTelegramConnectCommand'));
		assert.ok(connectSource.includes('let activePairingSession: TelegramConnectSession | undefined'));
		assert.strictEqual([extensionSource, connectSource, refreshSource, onboardingSource, toggleSource].some((source) => source.includes('pairingInProgress')), false);
		assert.strictEqual([extensionSource, connectSource, refreshSource, onboardingSource, toggleSource].some((source) => source.includes('withProgress')), false);
		assert.ok(connectSource.includes('getTelegramConnection(credential)'));
		assert.ok(connectSource.includes('createPairing(credential)'));
		assert.ok(extensionSource.includes('createTelegramAlertsToggleCommand'));
		assert.ok(connectSource.includes("if (existingSession.state === 'expired')"));
		assert.ok(connectSource.includes('existingSession.reveal();'));
		assert.ok(connectSource.includes('activePairingSession = session;'));
		assert.ok(connectSource.includes('if (activePairingSession !== session || sessionRevision !== pairingSessionRevision)'));
		assert.ok(connectSource.includes('if (activePairingSession !== completedSession)'));
		assert.ok(connectSource.includes('sessionConnectionStateRevision === dependencies.getConnectionStateRevision()'));
		assert.ok(sessionSource.includes('DEFAULT_POLL_INTERVAL_MS = 3_000'));
		assert.ok(sessionSource.includes('pollInFlight'));
		assert.ok(extensionSource.includes("let alertsEnabled = false"));
		assert.ok(extensionSource.includes("let connectionState: TelegramConnectionState = 'unknown'"));
		assert.ok(extensionSource.includes('let connectionStateRevision = 0'));
		assert.ok(extensionSource.includes('createTelegramConnectionStateRefresh'));
		assert.ok(extensionSource.includes('beginAuthoritativeRefresh'));
		assert.ok(refreshSource.includes('const refreshRevision = dependencies.beginAuthoritativeRefresh()'));
		assert.ok(refreshSource.includes('dependencies.getConnectionStateRevision() === refreshRevision'));
		assert.ok(extensionSource.includes('createTelegramOnboarding'));
		assert.ok(extensionSource.includes('runTelegramActivationOnboarding'));
		assert.ok(onboardingSource.includes('dependencies.onboarding.maybeShow(dependencies.getConnectionState())'));
		assert.ok(connectSource.includes("applySessionConnectionState('connected')"));
		assert.ok(connectSource.includes("applySessionConnectionState('disconnected')"));
	});

	test('pairing material is not persisted by extension state', () => {
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
		const connectSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramConnectCommand.ts'), 'utf8');
		const refreshSource = fs.readFileSync(path.resolve(__dirname, '../../src/state/TelegramConnectionStateRefresh.ts'), 'utf8');
		const onboardingSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramOnboarding.ts'), 'utf8');
		const toggleSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramAlertsToggleCommand.ts'), 'utf8');
		const secretStoreSource = fs.readFileSync(path.resolve(__dirname, '../../src/state/SecretStore.ts'), 'utf8');

		assert.ok(onboardingSource.includes(TELEGRAM_ONBOARDING_SHOWN_KEY));
		assert.strictEqual([extensionSource, connectSource, refreshSource, onboardingSource, toggleSource].some((source) => source.includes('workspaceState')), false);
		assert.strictEqual(secretStoreSource.includes('pairing'), false);
		assert.strictEqual(secretStoreSource.includes('telegramUrl'), false);
	});

	test('workspace configuration cannot select the backend for authenticated requests', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');

		assert.strictEqual(packageJson.contributes?.configuration?.properties?.['farAway.backendUrl'], undefined);
		assert.strictEqual(extensionSource.includes('workspace.getConfiguration'), false);
		assert.ok(extensionSource.includes('new BackendClient(PRODUCTION_BACKEND_URL)'));
	});
});
