// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCAN = join(__dirname, '../scripts/privacy-scan.mjs');

/** Builds a fake main.js + main.meta.json from modules, runs the scan on it. */
function scan(modules: Record<string, string>, externals: string[] = ['obsidian']): { ok: boolean; out: string } {
	const dir = mkdtempSync(join(tmpdir(), 'privacy-scan-'));
	// Pad with harmless modules so the "is it minified?" check passes.
	const all = { ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`src/pad${i}.ts`, `var x${i} = ${i};`])), ...modules };
	const js = Object.entries(all).map(([name, code]) => `// ${name}\n${code}\n`).join('\n');
	const inputs = Object.fromEntries(Object.entries(all).map(([name, code]) => [name, { bytesInOutput: code.length }]));
	writeFileSync(join(dir, 'main.js'), js);
	writeFileSync(join(dir, 'main.meta.json'), JSON.stringify({ outputs: { 'main.js': { entryPoint: 'src/main.ts', inputs, imports: externals.map((path) => ({ path, kind: 'require-call', external: true })) } } }));
	try {
		return { ok: true, out: execFileSync('node', [SCAN, join(dir, 'main.js')], { encoding: 'utf8', stdio: 'pipe' }) };
	} catch (e: any) {
		return { ok: false, out: `${e.stdout}${e.stderr}` };
	}
}

describe('privacy scan of the bundle', () => {
	it('passes a bundle with only reviewed code', () => {
		const r = scan({ 'node_modules/typebox/build/index.mjs': 'var Type = {};' });
		expect(r.out).toContain('Privacy scan passed');
		expect(r.ok).toBe(true);
	});

	it('fails on a new dependency, even one with no network code', () => {
		const r = scan({ 'node_modules/left-pad/index.js': 'module.exports = (s) => s;' });
		expect(r.ok).toBe(false);
		expect(r.out).toContain('New package in main.js: left-pad');
	});

	it('fails when a reviewed module starts calling the network or names a new host', () => {
		const r = scan({ 'src/services/Telemetry.ts': 'fetch("https://collector.example.io/v1", { method: "POST", body: notes });' });
		expect(r.ok).toBe(false);
		expect(r.out).toContain('src/services/Telemetry.ts uses fetch');
		expect(r.out).toContain('New host in main.js: collector.example.io');
	});

	it('fails on telemetry SDKs and beacons', () => {
		const r = scan({ 'src/x.ts': 'Sentry.init({}); navigator.sendBeacon(u, d);' });
		expect(r.ok).toBe(false);
		expect(r.out).toMatch(/mentions "Sentry"/);
		expect(r.out).toContain('uses sendBeacon');
	});

	it('always fails on Node networking, child processes and electron, whatever the allowlist says', () => {
		for (const ext of ['node:https', 'http', 'net', 'child_process', 'electron']) {
			const r = scan({}, ['obsidian', ext]);
			expect(r.ok, ext).toBe(false);
			expect(r.out).toContain('never allowed');
		}
	});

	it('fails on MCP network transports', () => {
		const r = scan({ 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js': 'var t = 1;' });
		expect(r.ok).toBe(false);
		expect(r.out).toContain('MCP network transport');
	});
});
