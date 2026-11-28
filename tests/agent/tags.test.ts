// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { extractTags, hasAllTags, normalizeTag, parseTagFilter } from '../../src/agent/search/tags';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { InMemoryVault } from '../mocks/InMemoryVault';

describe('extractTags', () => {
	it('reads frontmatter lists, inline lists and inline #tags', () => {
		expect(extractTags('---\ntags:\n  - Personal\n  - "project/garden"\n---\nBody #Idea here')).toEqual(['personal', 'project/garden', 'idea']);
		expect(extractTags('---\ntags: [work, "#urgent"]\ntitle: x\n---\n')).toEqual(['work', 'urgent']);
		expect(extractTags('---\ntag: solo\n---\ntext')).toEqual(['solo']);
	});

	it('ignores headings, numbers, links and code', () => {
		const note = '# Heading\n## Sub\nIssue #123 and [link](http://x.com/#anchor)\n`#notatag`\n```\n#include <x>\n```\nreal #tag_1, (#nested/child)';
		expect(extractTags(note)).toEqual(['tag_1', 'nested/child']);
	});

	it('handles CRLF and no frontmatter', () => {
		expect(extractTags('---\r\ntags: a\r\n---\r\n#b')).toEqual(['a', 'b']);
		expect(extractTags('just text')).toEqual([]);
	});
});

describe('tag matching', () => {
	it('normalises and matches nested tags like Obsidian', () => {
		expect(normalizeTag('#Personal/')).toBe('personal');
		expect(hasAllTags(['project/garden', 'personal'], ['project'])).toBe(true);
		expect(hasAllTags(['project/garden'], ['project/garden', 'personal'])).toBe(false);
		expect(hasAllTags(['projects'], ['project'])).toBe(false);
		expect(parseTagFilter('#a, b  #C')).toEqual(['a', 'b', 'c']);
		expect(parseTagFilter(['#x', 3, ''])).toEqual(['x']);
		expect(parseTagFilter(undefined)).toEqual([]);
	});
});

describe('VaultSearch tag filters', () => {
	const vault = () =>
		new InMemoryVault({
			'Journal/Day.md': '---\ntags: [personal]\n---\nWent hiking with the dog.',
			'Work/Plan.md': 'Hiking offsite plan #work',
			'Garden/Beds.md': 'Raised beds #project/garden hiking path',
			'Private/Secret.md': '#personal hiking secret',
		});

	it('limits search, grep and listing to tagged notes and respects exclusions', async () => {
		const search = new VaultSearch(vault(), () => ({ excludedFolders: ['Private'] }));
		expect((await search.search('hiking', 10, undefined, ['personal'])).map((h) => h.path)).toEqual(['Journal/Day.md']);
		expect((await search.grep('hiking', { tags: ['project'] })).map((m) => m.path)).toEqual(['Garden/Beds.md']);
		expect((await search.notesWithTags(['work'])).map((f) => f.path)).toEqual(['Work/Plan.md']);
		expect(await search.tagCounts()).toEqual([
			{ tag: 'personal', count: 1 },
			{ tag: 'project/garden', count: 1 },
			{ tag: 'work', count: 1 },
		]);
	});

	it('picks up tag changes when a note is edited', async () => {
		const v = vault();
		const search = new VaultSearch(v);
		expect((await search.notesWithTags(['work'])).map((f) => f.path)).toEqual(['Work/Plan.md']);
		v.set('Work/Plan.md', 'Hiking offsite plan #personal');
		expect(await search.notesWithTags(['work'])).toEqual([]);
		expect((await search.notesWithTags(['personal'])).map((f) => f.path).sort()).toEqual(['Journal/Day.md', 'Private/Secret.md', 'Work/Plan.md']);
	});
});
