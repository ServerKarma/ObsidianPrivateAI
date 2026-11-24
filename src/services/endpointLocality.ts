/**
 * Whether the configured server runs on this computer. Private AI only promises
 * that nothing leaves the device when it does; a server elsewhere (another PC on
 * the network, a cloud host) receives the questions and the note text the agent
 * reads, so the settings tab says so.
 */
export function remoteServerHost(endpoint: string): string | null {
	let host: string;
	try {
		const url = new URL(endpoint.trim());
		if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
		host = url.hostname.toLowerCase();
	} catch {
		return null; // Not a URL yet; the chat refuses it anyway.
	}
	const bare = host.replace(/^\[|\]$/g, '');
	if (bare === 'localhost' || bare.endsWith('.localhost')) return null;
	if (/^127\.\d+\.\d+\.\d+$/.test(bare) || bare === '::1' || bare === '0.0.0.0') return null;
	return bare;
}

export function remoteServerWarning(endpoint: string): string {
	const host = remoteServerHost(endpoint);
	return host
		? `This server is not on this computer. Your questions and the notes the AI reads are sent to ${host}. Use a server on this computer (localhost) to keep everything on this device.`
		: '';
}
