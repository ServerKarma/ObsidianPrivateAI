import { describe, expect, it } from 'vitest';
import { remoteServerHost, remoteServerWarning } from '../src/services/endpointLocality';

describe('remote server warning', () => {
	it('treats loopback servers as on this computer', () => {
		for (const url of ['http://localhost:1234/v1/chat/completions', 'http://127.0.0.1:11434/v1', 'http://[::1]:8080/v1', 'http://lmstudio.localhost/v1']) {
			expect(remoteServerHost(url), url).toBeNull();
			expect(remoteServerWarning(url)).toBe('');
		}
	});

	it('names any other host, including LAN machines', () => {
		expect(remoteServerHost('http://192.168.1.20:1234/v1')).toBe('192.168.1.20');
		expect(remoteServerHost('https://api.example.com/v1')).toBe('api.example.com');
		expect(remoteServerWarning('http://gaming-pc:1234/v1')).toContain('sent to gaming-pc');
	});

	it('says nothing while the URL is incomplete', () => {
		expect(remoteServerHost('')).toBeNull();
		expect(remoteServerHost('localhost:1234')).toBeNull();
	});
});
