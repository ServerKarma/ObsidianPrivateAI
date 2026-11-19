// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createVaultTools } from '../../src/agent/tools/vaultTools';
import { createVaultMcpServer } from '../../src/agent/mcp/vaultMcpServer';
import { connectInProcess } from '../../src/agent/mcp/inProcessClient';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { InMemoryVault } from '../mocks/InMemoryVault';

const FIXTURE = {
	'Home/Water Heater Replacement.md': '# Water Heater Replacement\n\nReplaced the 50 gallon water heater on 2024-03-15.\nCost: $1,850 installed.',
	'Home/Dishwasher Repair.md': '# Dishwasher Repair\n\nFixed the drain pump in May.',
	'Recipes/Sourdough.md': '# Sourdough\n\n500g flour, 350g water.',
	'Private/Diary.md': 'secret water heater thoughts',
};

let client: Client | null = null;
afterEach(async () => {
	await client?.close();
	client = null;
});

async function setup(allowWrites = true) {
	const vault = new InMemoryVault(FIXTURE);
	const search = new VaultSearch(vault, () => ({ excludedFolders: ['Private'] }));
	const tools = createVaultTools({ vault, search });
	let writes = allowWrites;
	const server = createVaultMcpServer(tools, { version: 'test', allowWrites: () => writes });
	client = await connectInProcess(server, 'test');
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await client!.callTool({ name, arguments: args });
		const text = (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
		return { text, isError: !!r.isError };
	};
	return { vault, call, setWrites: (v: boolean) => (writes = v) };
}

describe('built-in MCP server', () => {
	it('publishes every vault tool with schemas and annotations', async () => {
		await setup();
		const { tools } = await client!.listTools();
		expect(tools.map((t) => t.name)).toEqual([
			'search_notes', 'grep_notes', 'list_notes', 'get_open_notes', 'read_note',
			'create_note', 'edit_note', 'append_to_note', 'move_note', 'delete_note',
		]);
		const search = tools.find((t) => t.name === 'search_notes')!;
		expect(search.inputSchema).toMatchObject({ type: 'object', required: ['query'] });
		expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tools.find((t) => t.name === 'delete_note')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
	});

	it('hides and refuses write tools when note changes are off', async () => {
		const { call, setWrites } = await setup(false);
		const { tools } = await client!.listTools();
		expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
		const r = await call('delete_note', { path: 'Recipes/Sourdough.md' });
		expect(r).toMatchObject({ isError: true });
		expect(r.text).toMatch(/turned off/);
		setWrites(true);
		expect((await client!.listTools()).tools.some((t) => t.name === 'delete_note')).toBe(true);
	});

	it('searches, greps and reads, never showing excluded notes', async () => {
		const { call } = await setup();
		const found = await call('search_notes', { query: 'water heater' });
		expect(found.text.split('\n')[0]).toContain('Home/Water Heater Replacement.md');
		expect(found.text).not.toContain('Private/');

		const grep = await call('grep_notes', { pattern: '$1,850' });
		expect(grep.text).toBe('Home/Water Heater Replacement.md:4: Cost: $1,850 installed.');

		const read = await call('read_note', { path: 'Water Heater Replacement' });
		expect(read.text).toContain('2024-03-15');
		expect(read.text).toMatch(/^# Home\/Water Heater Replacement.md \(lines 1-4 of 4/);

		expect((await call('read_note', { path: 'Private/Diary.md' })).isError).toBe(true);
		expect((await call('read_note', { path: '../outside.md' })).text).toMatch(/inside the vault/);
		expect((await call('list_notes', { folder: 'Home' })).text.split('\n')).toHaveLength(2);
	});

	it('pages long notes', async () => {
		const { vault, call } = await setup();
		vault.set('Long.md', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
		const page = await call('read_note', { path: 'Long.md', start_line: 11, max_lines: 5 });
		expect(page.text).toContain('lines 11-15 of 30');
		expect(page.text).toContain('line 15');
		expect(page.text).not.toContain('\nline 16');
		expect(page.text).toContain('start_line 16');
	});

	it('creates, edits, appends, moves and trashes notes', async () => {
		const { vault, call } = await setup();
		expect((await call('create_note', { path: 'Projects/Garden', content: 'Plant tomatoes' })).text).toBe('Created Projects/Garden.md (14 characters).');
		expect((await call('create_note', { path: 'Projects/Garden.md', content: 'x' })).isError).toBe(true);

		expect((await call('edit_note', { path: 'Projects/Garden.md', old_text: 'tomatoes', new_text: 'peppers' })).isError).toBe(false);
		expect(await vault.read('Projects/Garden.md')).toBe('Plant peppers');
		expect((await call('edit_note', { path: 'Projects/Garden.md', old_text: 'missing', new_text: '' })).text).toMatch(/not found/);

		await call('append_to_note', { path: 'Projects/Garden.md', content: 'Water daily' });
		expect(await vault.read('Projects/Garden.md')).toBe('Plant peppers\nWater daily');

		await call('move_note', { from: 'Projects/Garden.md', to: 'Archive/Garden.md' });
		expect(vault.getFile('Archive/Garden.md')).not.toBeNull();

		await call('delete_note', { path: 'Archive/Garden.md' });
		expect(vault.trashed).toEqual(['Archive/Garden.md']);
		expect((await call('create_note', { path: 'Private/new.md', content: 'x' })).text).toMatch(/excluded/);
	});

	it('reports which notes are open', async () => {
		const { vault, call } = await setup();
		vault.active = 'Home/Dishwasher Repair.md';
		vault.open = ['Home/Dishwasher Repair.md', 'Private/Diary.md'];
		const r = await call('get_open_notes');
		expect(r.text).toContain('Active note: Home/Dishwasher Repair.md');
		expect(r.text).not.toContain('Private');
	});
});
