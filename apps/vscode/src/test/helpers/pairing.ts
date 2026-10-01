export const PAIRING_ID = 'pairing_123';

export function futurePairing(expiresAt: number): { pairingId: string; telegramUrl: string; expiresAt: Date } {
	return {
		pairingId: PAIRING_ID,
		telegramUrl: 'https://t.me/far_away_bot?start=opaque-token',
		expiresAt: new Date(expiresAt),
	};
}
