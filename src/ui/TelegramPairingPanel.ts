import { randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import * as vscode from 'vscode';

const SVG_DATA_URI_PREFIX = 'data:image/svg+xml;base64,';

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

export function renderTelegramPairingHtml(qrDataUri: string, nonce = randomBytes(16).toString('hex')): string {
	if (!qrDataUri.startsWith(SVG_DATA_URI_PREFIX)) {
		throw new Error('Telegram pairing QR must be a local SVG data URI.');
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
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

.secondary {
	color: var(--vscode-descriptionForeground);
}
</style>
</head>
<body>
<main>
<h1>Connect Telegram</h1>
<p class="description">Scan this QR code with your phone to connect Telegram.</p>
<img class="qr-code" src="${qrDataUri}" alt="Telegram connection QR code">
<p class="secondary">The connection is associated with your Telegram account.</p>
</main>
</body>
</html>`;
}

export async function showTelegramPairingPanel(telegramUrl: string): Promise<vscode.WebviewPanel> {
	const qrDataUri = await generateTelegramPairingQrDataUri(telegramUrl);
	const panel = vscode.window.createWebviewPanel(
		'farAway.telegramPairing',
		'Connect Telegram',
		vscode.ViewColumn.One,
		{
			enableScripts: false,
			localResourceRoots: [],
		}
	);

	panel.webview.html = renderTelegramPairingHtml(qrDataUri);
	return panel;
}
