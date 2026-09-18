export function telegramConnectionResponse(connected: boolean, extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ connected, ...extra }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
