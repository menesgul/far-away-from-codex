/** Local command ordering only. The Worker remains the Telegram connection authority. */
export class LegacyTelegramCommandCoordinator {
	private owner = 0;
	private sequence = 0;
	private latestIntent = 0;
	private latestNonToggleIntent = 0;
	private kind: 'connect' | 'disconnect' | 'toggle' | undefined;
	private issuedDelete: Promise<'confirmed' | 'uncertain'> | undefined;
	private readonly credentialRecoveries = new Set<Promise<void>>();
	private disposed = false;

	public claim(kind: 'connect' | 'disconnect' | 'toggle', shareCurrent = false): number {
		if (shareCurrent && this.kind === kind) { return this.owner; }
		this.kind = kind;
		this.owner = ++this.sequence;
		this.latestIntent = this.owner;
		if (kind !== 'toggle') { this.latestNonToggleIntent = this.owner; }
		return this.owner;
	}

	/** Record a Toggle click without cancelling the Disconnect it is waiting for. */
	public claimDeferredToggle(): number {
		this.latestIntent = ++this.sequence;
		return this.latestNonToggleIntent;
	}

	public isLatestIntent(owner: number): boolean {
		return !this.disposed && this.latestIntent === owner;
	}

	public ownsDeferredToggle(nonToggleIntent: number): boolean {
		return !this.disposed && this.latestNonToggleIntent === nonToggleIntent;
	}

	public owns(owner: number): boolean {
		return !this.disposed && this.owner === owner;
	}

	public currentKind(): 'connect' | 'disconnect' | 'toggle' | undefined {
		return this.kind;
	}

	public deleteBarrier(): Promise<'confirmed' | 'uncertain'> | undefined {
		return this.issuedDelete;
	}

	public credentialBarrier(): Promise<void> | undefined {
		if (this.credentialRecoveries.size === 0) { return undefined; }
		// Capture every deletion issued before this command. Promise.all would
		// reject early and release Connect while another deletion was still live.
		return Promise.allSettled([...this.credentialRecoveries]).then((results) => {
			const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
			if (failed) { throw failed.reason; }
		});
	}

	public async recoverCredential(owner: number, action: () => Promise<void>): Promise<void> {
		if (!this.owns(owner)) { return; }
		const recovery = action();
		this.credentialRecoveries.add(recovery);
		try { await recovery; }
		finally { this.credentialRecoveries.delete(recovery); }
	}

	/** An issued request remains a barrier even when its original UI owner was superseded. */
	public async issueDelete(owner: number, request: () => Promise<void>): Promise<void> {
		const earlier = this.issuedDelete;
		if (earlier) {
			const outcome = await earlier;
			if (!this.owns(owner)) { return; }
			if (outcome === 'confirmed') { return; }
		}
		if (!this.owns(owner)) { return; }
		const issued = request();
		const settled = issued.then(
			() => 'confirmed' as const,
			() => 'uncertain' as const,
		);
		this.issuedDelete = settled;
		try { await issued; }
		finally {
			if (this.issuedDelete === settled) { this.issuedDelete = undefined; }
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.owner += 1;
	}
}
