import { randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import * as vscode from 'vscode';

const SVG_DATA_URI_PREFIX = 'data:image/svg+xml;base64,';

export type PairingPanelMessage =
	| { type: 'copy-link' }
	| { type: 'open-on-this-device' }
	| { type: 'cancel' }
	| { type: 'close' };

type PairingPanelViewState = 'waiting' | 'expired';

const PAIRING_PANEL_MESSAGE_TYPES = new Set<PairingPanelMessage['type']>([
	'copy-link',
	'open-on-this-device',
	'cancel',
	'close',
]);

export function isPairingPanelMessage(value: unknown): value is PairingPanelMessage {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const message = value as Record<string, unknown>;
	return Object.prototype.hasOwnProperty.call(message, 'type')
		&& Object.keys(message).length === 1
		&& typeof message.type === 'string'
		&& PAIRING_PANEL_MESSAGE_TYPES.has(message.type as PairingPanelMessage['type']);
}

export async function generateTelegramPairingQrDataUri(telegramUrl: string): Promise<string> {
	const svg = await QRCode.toString(telegramUrl, {
		type: 'svg',
		errorCorrectionLevel: 'M',
		margin: 4,
		color: {
			dark: '#000000ff',
			light: '#ffffffff',
		},
	});

	return `${SVG_DATA_URI_PREFIX}${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export function renderTelegramPairingHtml(qrDataUri: string, nonce = createNonce()): string {
	assertLocalSvgDataUri(qrDataUri);

	return renderPage({
		nonce,
		body: `<main>
<h1>Connect Telegram</h1>
<p class="description">Scan this QR code with your phone to connect Telegram.</p>
<img class="qr-code" src="${qrDataUri}" alt="Telegram connection QR code">
<div class="actions" aria-label="Telegram pairing actions">
<button type="button" data-action="copy-link">Copy Link</button>
<button type="button" data-action="open-on-this-device">Open on This Device</button>
<button type="button" class="secondary-button" data-action="cancel">Cancel</button>
</div>
<p class="secondary">The connection is associated with your Telegram account.</p>
</main>`,
	});
}

export function renderTelegramPairingExpiredHtml(nonce = createNonce()): string {
	return renderPage({
		nonce,
		body: `<main>
<h1>Pairing expired</h1>
<p class="description">This QR code is no longer valid.</p>
<p class="secondary expiry-guidance">Run Connect Telegram again to create a new pairing.</p>
<div class="actions">
<button type="button" data-action="close">Close</button>
</div>
</main>`,
	});
}

/**
 * A UI-only surface for a transient Telegram pairing QR code. It contains no
 * backend, credential, polling, or global connection-state knowledge.
 */
export class TelegramPairingPanel implements vscode.Disposable {
	private readonly actionEmitter = new vscode.EventEmitter<PairingPanelMessage>();
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	private readonly panelDisposables: vscode.Disposable[] = [];
	private viewState: PairingPanelViewState = 'waiting';
	private disposed = false;

	public readonly onDidReceiveAction = this.actionEmitter.event;
	public readonly onDidDispose = this.disposeEmitter.event;

	public constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly qrDataUri: string
	) {
		assertLocalSvgDataUri(qrDataUri);
		this.panel.webview.html = renderTelegramPairingHtml(qrDataUri);
		this.panelDisposables.push(this.panel.webview.onDidReceiveMessage((message: unknown) => {
			if (!this.disposed && isPairingPanelMessage(message)) {
				this.actionEmitter.fire(message);
			}
		}));
		this.panelDisposables.push(this.panel.onDidDispose(() => this.markDisposed()));
	}

	public static async create(telegramUrl: string): Promise<TelegramPairingPanel> {
		const qrDataUri = await generateTelegramPairingQrDataUri(telegramUrl);
		const panel = vscode.window.createWebviewPanel(
			'farAway.telegramPairing',
			'Connect Telegram',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [],
			}
		);

		return new TelegramPairingPanel(panel, qrDataUri);
	}

	public get isDisposed(): boolean {
		return this.disposed;
	}

	public get isExpired(): boolean {
		return this.viewState === 'expired';
	}

	public showExpired(): void {
		if (this.disposed || this.viewState === 'expired') {
			return;
		}

		this.viewState = 'expired';
		this.panel.webview.html = renderTelegramPairingExpiredHtml();
	}

	public reveal(): boolean {
		if (this.disposed) {
			return false;
		}

		this.panel.reveal(this.panel.viewColumn, false);
		return true;
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.markDisposed();
		this.panel.dispose();
	}

	private markDisposed(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		for (const disposable of this.panelDisposables.splice(0)) {
			disposable.dispose();
		}
		this.disposeEmitter.fire();
		this.actionEmitter.dispose();
		this.disposeEmitter.dispose();
	}
}

function renderPage({ nonce, body }: { nonce: string; body: string }): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Telegram</title>
<style nonce="${nonce}">
body {
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	line-height: 1.5;
	margin: 0;
}

main {
	box-sizing: border-box;
	max-width: 32rem;
	margin: 0 auto;
	padding: 2rem;
}

h1 {
	font-size: 1.5rem;
	font-weight: 600;
	margin: 0 0 0.75rem;
}

p {
	margin: 0;
}

.description {
	margin-bottom: 1.5rem;
}

.qr-code {
	display: block;
	width: min(100%, 18rem);
	height: auto;
	margin: 0 auto 1.5rem;
	border: 1px solid var(--vscode-focusBorder);
	background: #fff;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin: 1rem 0;
}

button {
	border: 1px solid var(--vscode-button-border, transparent);
	border-radius: 2px;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	padding: 0.4rem 0.8rem;
	cursor: pointer;
}

button:hover {
	background: var(--vscode-button-hoverBackground);
}

.secondary-button {
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
}

.secondary-button:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}

.secondary {
	color: var(--vscode-descriptionForeground);
}

.expiry-guidance {
	margin-bottom: 1rem;
}
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('button[data-action]')) {
	button.addEventListener('click', () => {
		const type = button.dataset.action;
		if (type === 'copy-link' || type === 'open-on-this-device' || type === 'cancel' || type === 'close') {
			vscode.postMessage({ type });
		}
	});
}
</script>
</body>
</html>`;
}

function assertLocalSvgDataUri(qrDataUri: string): void {
	if (!qrDataUri.startsWith(SVG_DATA_URI_PREFIX)) {
		throw new Error('Telegram pairing QR must be a local SVG data URI.');
	}
}

function createNonce(): string {
	return randomBytes(16).toString('hex');
}
