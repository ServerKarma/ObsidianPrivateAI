// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BM25Index } from '../../src/agent/search/BM25Index';
import { stem, tokenize } from '../../src/agent/search/tokenize';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { isExcluded } from '../../src/agent/vault/exclusions';
import { InMemoryVault } from '../mocks/InMemoryVault';

describe('tokenize', () => {
	it('lowercases, drops stopwords and stems plurals and tenses', () => {
		expect(tokenize('When did I replace the Water Heaters?')).toEqual(['replace', 'water', 'heater']);
		expect(stem('replaced')).toBe(stem('replacing'));
		expect(stem('batteries')).toBe('battery');
		expect(stem('2024')).toBe('2024');
	});

	it('folds accents', () => {
		expect(tokenize('Café crème')).toEqual(['cafe', 'creme']);
	});
});

describe('BM25Index', () => {
	const index = new BM25Index();
	index.upsert({ path: 'Home/Water Heater Replacement.md', title: 'Water Heater Replacement', body: 'Replaced the water heater on 2024-03-15 for $1,850.', mtime: 1 });
	index.upsert({ path: 'Home/Dishwasher Repair.md', title: 'Dishwasher Repair', body: 'The dishwasher pump was replaced. Water was leaking.', mtime: 1 });
	index.upsert({ path: 'Recipes/Bread.md', title: 'Bread', body: 'Flour, water, salt and yeast.', mtime: 1 });

	it('ranks the note whose title and body match best first', () => {
		const hits = index.search('when did I replace the water heater');
		expect(hits[0].path).toBe('Home/Water Heater Replacement.md');
		expect(hits[0].snippet).toContain('2024-03-15');
		expect(hits.map((h) => h.path)).toContain('Home/Dishwasher Repair.md');
	});

	it('returns nothing for unknown terms and respects filters', () => {
		expect(index.search('zeppelin')).toEqual([]);
		expect(index.search('water', 10, (p) => p.startsWith('Recipes/')).map((h) => h.path)).toEqual(['Recipes/Bread.md']);
	});

	it('forgets removed documents', () => {
		const i = new BM25Index();
		i.upsert({ path: 'a.md', title: 'a', body: 'unique words here', mtime: 1 });
		i.remove('a.md');
		expect(i.search('unique')).toEqual([]);
		expect(i.size).toBe(0);
	});
});

describe('exclusions', () => {
	it('matches folders, globs and extensions', () => {
		const rules = { excludedFolders: ['Private', 'clippings/*/_res'], excludedFilePatterns: ['*.csv', 'secret.md', 'Daily/*.tmp'] };
		expect(isExcluded('Private/diary.md', rules)).toBe(true);
		expect(isExcluded('PrivateNotes/x.md', rules)).toBe(false);
		expect(isExcluded('clippings/web/_res/a.png', rules)).toBe(true);
		expect(isExcluded('data/table.csv', rules)).toBe(true);
		expect(isExcluded('Work/secret.md', rules)).toBe(true);
		expect(isExcluded('Daily/x.tmp', rules)).toBe(true);
		expect(isExcluded('Work/plan.md', rules)).toBe(false);
	});
});

describe('VaultSearch', () => {
	it('re-reads only changed files and drops deleted ones', async () => {
		const vault = new InMemoryVault({ 'a.md': 'alpha content', 'b.md': 'beta content' });
		const search = new VaultSearch(vault);
		expect((await search.search('alpha')).map((h) => h.path)).toEqual(['a.md']);

		vault.set('a.md', 'gamma content');
		vault.files.delete('b.md');
		expect(await search.search('alpha')).toEqual([]);
		expect((await search.search('gamma')).map((h) => h.path)).toEqual(['a.md']);
		expect(await search.search('beta')).toEqual([]);
	});

	it('hides excluded notes from search and grep', async () => {
		const vault = new InMemoryVault({ 'Private/x.md': 'needle', 'Public/y.md': 'needle' });
		const search = new VaultSearch(vault, () => ({ excludedFolders: ['Private'] }));
		expect((await search.search('needle')).map((h) => h.path)).toEqual(['Public/y.md']);
		expect((await search.grep('needle')).map((m) => m.path)).toEqual(['Public/y.md']);
	});

	it('greps literal text, regexes and reports line numbers', async () => {
		const vault = new InMemoryVault({ 'n.md': 'line one\nCost: $1,850 (a+b)\nline three' });
		const search = new VaultSearch(vault);
		expect(await search.grep('$1,850 (a+b)')).toEqual([{ path: 'n.md', line: 2, text: 'Cost: $1,850 (a+b)' }]);
		expect((await search.grep('^line', { regex: true })).map((m) => m.line)).toEqual([1, 3]);
		expect(await search.grep('LINE ONE', { caseSensitive: true })).toEqual([]);
		await expect(search.grep('(', { regex: true })).rejects.toThrow(/Invalid regular expression/);
	});

	it('indexes text extracted from images', async () => {
		const vault = new InMemoryVault({ 'img/receipt.png': '<binary>', 'note.md': 'nothing here' });
		const search = new VaultSearch(vault, undefined, { getText: (f) => (f.path === 'img/receipt.png' ? 'Furnace service invoice' : undefined) });
		const hits = await search.search('furnace invoice');
		expect(hits).toEqual([expect.objectContaining({ path: 'img/receipt.png', kind: 'image' })]);
	});
});
