import {
	generateTelegramPairingQrDataUri,
	renderTelegramPairingHtml,
	isPairingPanelMessage,
	renderTelegramPairingExpiredHtml,
} from '../../ui/TelegramPairingPanel';
import * as assert from 'assert';

suite('TelegramPairingPanel', () => {
	test('Telegram pairing QR is generated locally as an SVG data URI', async () => {
		const telegramUrl = 'https://t.me/far_away_bot?start=opaque-token';
		const qrDataUri = await generateTelegramPairingQrDataUri(telegramUrl);

		assert.ok(qrDataUri.startsWith('data:image/svg+xml;base64,'));
		const svg = Buffer.from(qrDataUri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
		assert.ok(svg.startsWith('<svg'));
		assert.ok(svg.includes('viewBox='));
	});

	test('Telegram pairing HTML safely renders a local QR image without exposing the pairing URL', async () => {
		const telegramUrl = 'https://t.me/far_away_bot?start=opaque-token';
		const html = renderTelegramPairingHtml(await generateTelegramPairingQrDataUri(telegramUrl), 'test-nonce');

		assert.ok(html.includes('<img class="qr-code"'));
		assert.strictEqual(html.includes('<svg'), false);
		assert.ok(html.includes("default-src 'none'"));
		assert.ok(html.includes('img-src data:'));
		assert.ok(html.includes("style-src 'nonce-test-nonce'"));
		assert.ok(html.includes("script-src 'nonce-test-nonce'"));
		assert.ok(html.includes("base-uri 'none'"));
		assert.ok(html.includes("form-action 'none'"));
		assert.ok(html.includes('nonce="test-nonce"'));
		assert.ok(html.includes('acquireVsCodeApi()'));
		assert.strictEqual(html.includes('http://'), false);
		assert.strictEqual(html.includes('https://'), false);
		assert.strictEqual(html.includes(telegramUrl), false);
		assert.strictEqual(html.includes('opaque-token'), false);
		assert.strictEqual(html.includes('fetch('), false);
		assert.strictEqual(html.includes('XMLHttpRequest'), false);
		assert.strictEqual(html.includes('WebSocket'), false);
		assert.strictEqual(html.includes('localStorage'), false);
		assert.strictEqual(html.includes('sessionStorage'), false);
	});

	test('pairing panel accepts only exact action-only messages and expired markup has Close only', () => {
		for (const message of [
			{ type: 'copy-link' },
			{ type: 'open-on-this-device' },
			{ type: 'cancel' },
			{ type: 'close' },
		]) {
			assert.strictEqual(isPairingPanelMessage(message), true);
		}
		for (const message of [
			null,
			{},
			{ type: 'copy-link', telegramUrl: 'https://t.me/token' },
			{ type: 'unknown' },
			{ type: 7 },
			['copy-link'],
		]) {
			assert.strictEqual(isPairingPanelMessage(message), false);
		}

		const expiredHtml = renderTelegramPairingExpiredHtml('expired-nonce');
		assert.ok(expiredHtml.includes('Pairing expired'));
		assert.ok(expiredHtml.includes('This QR code is no longer valid.'));
		assert.ok(expiredHtml.includes('Run Connect Telegram again to create a new pairing.'));
		assert.ok(expiredHtml.includes('data-action="close"'));
		assert.strictEqual(expiredHtml.includes('data-action="copy-link"'), false);
		assert.strictEqual(expiredHtml.includes('data-action="open-on-this-device"'), false);
		assert.strictEqual(expiredHtml.includes('data-action="cancel"'), false);
		assert.strictEqual(expiredHtml.includes('opaque-token'), false);
	});
});
