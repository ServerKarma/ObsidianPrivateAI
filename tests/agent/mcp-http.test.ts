// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpHttpHost } from '../../src/agent/mcp/McpHttpHost';
import { createVaultMcpServer } from '../../src/agent/mcp/vaultMcpServer';
import { createVaultTools } from '../../src/agent/tools/vaultTools';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { InMemoryVault } from '../mocks/InMemoryVault';

// A fresh port per test so pooled keep-alive sockets from an earlier test are never reused.
let PORT = 40000 + Math.floor(Math.random() * 20000);
const TOKEN = 'test-token';
let host: McpHttpHost | null = null;

afterEach(async () => {
	await host?.stop();
	host = null;
});

async function startHost() {
	PORT += 1;
	const vault = new InMemoryVault({ 'Home/Water Heater.md': 'Replaced on 2024-03-15' });
	const tools = createVaultTools({ vault, search: new VaultSearch(vault) });
	host = new McpHttpHost({ port: PORT, token: TOKEN, createServer: () => createVaultMcpServer(tools, { version: 't', allowWrites: () => false }) });
	await host.start();
	return host;
}

describe('MCP over localhost HTTP', () => {
	it('serves the vault tools to an external MCP client with the bearer token', async () => {
		const h = await startHost();
		expect(h.url).toBe(`http://127.0.0.1:${PORT}/mcp`);
		const client = new Client({ name: 'external', version: '1' });
		await client.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain('search_notes');
		expect(tools.some((t) => t.name === 'delete_note')).toBe(false);
		const r = await client.callTool({ name: 'grep_notes', arguments: { pattern: '2024' } });
		expect((r.content as Array<{ text: string }>)[0].text).toBe('Home/Water Heater.md:1: Replaced on 2024-03-15');
		await client.close();
	});

	it('rejects requests without the token, on other paths, and non-POST methods', async () => {
		const h = await startHost();
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
		expect((await fetch(h.url, { method: 'POST', headers, body })).status).toBe(401);
		expect((await fetch(`http://127.0.0.1:${PORT}/other`, { method: 'POST', headers, body })).status).toBe(404);
		expect((await fetch(h.url, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
	});

	it('stops listening when stopped', async () => {
		const h = await startHost();
		await h.stop();
		host = null;
		await expect(fetch(h.url, { method: 'POST' })).rejects.toThrow();
	});
});
