// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CleanupAdapter, removeLegacyEmbeddingFiles } from '../src/services/LegacyEmbeddingCleanup';

/** A tiny in-memory filesystem with the parts of Obsidian's DataAdapter the cleanup uses. */
function fakeFs(files: Record<string, number>, folders: string[]): CleanupAdapter & { files: Map<string, number>; folders: Set<string> } {
	const f = new Map(Object.entries(files));
	const d = new Set(folders);
	const children = (dir: string) => ({
		files: [...f.keys()].filter((p) => p.slice(0, p.lastIndexOf('/')) === dir),
		folders: [...d].filter((p) => p.slice(0, p.lastIndexOf('/')) === dir),
	});
	return {
		files: f,
		folders: d,
		exists: async (p) => f.has(p) || d.has(p),
		list: async (p) => children(p),
		remove: async (p) => { f.delete(p); },
		rmdir: async (p) => {
			// The cleanup must only ever remove empty folders, even though it passes recursive=true.
			const c = children(p);
			if (c.files.length || c.folders.length) throw new Error(`refusing to remove non-empty ${p}`);
			d.delete(p);
		},
		stat: async (p) => (f.has(p) ? { size: f.get(p)! } : null),
	};
}

const opts = { configDir: '.obsidian', pluginDir: '.obsidian/plugins/private-ai', pluginId: 'private-ai' };

describe('legacy embedding cleanup', () => {
	it('deletes the SQLite index and the folder, keeping the plugin folder', async () => {
		const fs = fakeFs(
			{ '.obsidian/plugins/private-ai/vector-index/embeddings.db': 5_000_000, '.obsidian/plugins/private-ai/main.js': 1 },
			['.obsidian/plugins/private-ai', '.obsidian/plugins/private-ai/vector-index'],
		);
		const r = await removeLegacyEmbeddingFiles(fs, opts);
		expect(r.removedFiles).toEqual(['.obsidian/plugins/private-ai/vector-index/embeddings.db']);
		expect(r.bytesFreed).toBe(5_000_000);
		expect(fs.folders.has('.obsidian/plugins/private-ai/vector-index')).toBe(false);
		expect(fs.folders.has('.obsidian/plugins/private-ai')).toBe(true);
		expect(fs.files.has('.obsidian/plugins/private-ai/main.js')).toBe(true);
	});

	it('finds the old JSON indexes under the hard-coded ObsidianPrivateAI folder and removes that leftover folder', async () => {
		const base = '.obsidian/plugins/ObsidianPrivateAI';
		const fs = fakeFs(
			{ [`${base}/vector-index/text-embeddings.json`]: 10, [`${base}/vector-index/image-embeddings.json`]: 20, [`${base}/vector-index/embeddings.json`]: 30 },
			[base, `${base}/vector-index`],
		);
		const r = await removeLegacyEmbeddingFiles(fs, opts);
		expect(r.removedFiles).toHaveLength(3);
		expect(r.bytesFreed).toBe(60);
		expect(fs.folders.size).toBe(0);
	});

	it('handles the plugin installed in a folder that differs from its id', async () => {
		const fs = fakeFs(
			{ '.obsidian/plugins/private-ai/vector-index/embeddings.db': 1, '.obsidian/plugins/my-copy/main.js': 1 },
			['.obsidian/plugins/private-ai', '.obsidian/plugins/private-ai/vector-index', '.obsidian/plugins/my-copy'],
		);
		const r = await removeLegacyEmbeddingFiles(fs, { ...opts, pluginDir: '.obsidian/plugins/my-copy' });
		expect(r.removedFiles).toEqual(['.obsidian/plugins/private-ai/vector-index/embeddings.db']);
		expect(fs.folders.has('.obsidian/plugins/private-ai')).toBe(false);
		expect(fs.folders.has('.obsidian/plugins/my-copy')).toBe(true);
	});

	it('never deletes unknown files, and keeps a folder that still has them', async () => {
		const fs = fakeFs(
			{ '.obsidian/plugins/private-ai/vector-index/embeddings.db': 1, '.obsidian/plugins/private-ai/vector-index/notes.txt': 1 },
			['.obsidian/plugins/private-ai', '.obsidian/plugins/private-ai/vector-index'],
		);
		const r = await removeLegacyEmbeddingFiles(fs, opts);
		expect(r.removedFiles).toHaveLength(1);
		expect(fs.files.has('.obsidian/plugins/private-ai/vector-index/notes.txt')).toBe(true);
		expect(fs.folders.has('.obsidian/plugins/private-ai/vector-index')).toBe(true);
	});

	it('does nothing when there is nothing to clean, and reports errors instead of throwing', async () => {
		expect(await removeLegacyEmbeddingFiles(fakeFs({}, []), opts)).toEqual({ removedFiles: [], removedFolders: [], bytesFreed: 0, errors: [] });
		const broken = fakeFs({ '.obsidian/plugins/private-ai/vector-index/embeddings.db': 1 }, ['.obsidian/plugins/private-ai/vector-index']);
		broken.remove = async () => { throw new Error('EBUSY'); };
		const r = await removeLegacyEmbeddingFiles(broken, opts);
		expect(r.errors[0]).toContain('EBUSY');
	});
});
