import { describe, expect, it } from 'vitest';
import { ImageTextCache, ImageTextSource } from '../../src/agent/obsidian/ImageTextCache';

const CACHE_PATH = 'plugin/image-text-cache.json';

function fakeApp(files: Record<string, string> = {}) {
	return {
		files,
		vault: {
			adapter: {
				exists: async (p: string) => p in files,
				read: async (p: string) => files[p],
				write: async (p: string, data: string) => {
					files[p] = data;
				},
			},
		},
	};
}

const image = (path: string, mtime = 1, size = 10) => ({ path, extension: path.split('.').pop() ?? '', stat: { mtime, size } }) as any;

/** A vision model scripted per image path. */
function source(replies: Record<string, { text?: string; failed?: boolean; throws?: boolean }>): ImageTextSource & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async extractTextFromImage(file) {
			calls.push(file.path);
			const reply = replies[file.path] ?? {};
			if (reply.throws) throw new Error('server went away');
			if (reply.failed) return { success: false, extractedText: '', failed: true, error: 'request failed' };
			return reply.text ? { success: true, extractedText: reply.text } : { success: false, extractedText: '' };
		},
	};
}

describe('ImageTextCache', () => {
	it('keeps images whose request failed pending, so the next run reads them', async () => {
		const app = fakeApp();
		const cache = new ImageTextCache(app as any, CACHE_PATH);
		const files = [image('a.png'), image('b.png'), image('c.png')];

		const first = await cache.process(files, source({ 'a.png': { text: 'receipt total 12' }, 'b.png': { failed: true }, 'c.png': { throws: true } }));
		expect(first).toEqual({ processed: 1, empty: 0, failed: 2 });
		expect(cache.pending(files).map((f) => f.path)).toEqual(['b.png', 'c.png']);

		const retry = source({ 'b.png': { text: 'invoice 42' }, 'c.png': { text: 'whiteboard notes' } });
		expect(await cache.process(files, retry)).toEqual({ processed: 2, empty: 0, failed: 0 });
		expect(retry.calls).toEqual(['b.png', 'c.png']);
		expect(cache.getText({ path: 'b.png', mtime: 1, size: 10 } as any)).toBe('invoice 42');
		expect(cache.withTextCount).toBe(3);
	});

	it('remembers images with no text, and re-reads them only when asked to', async () => {
		const cache = new ImageTextCache(fakeApp() as any, CACHE_PATH);
		const files = [image('photo.jpg')];

		expect(await cache.process(files, source({}))).toEqual({ processed: 0, empty: 1, failed: 0 });
		expect(cache.pending(files)).toEqual([]);

		const background = source({ 'photo.jpg': { text: 'now readable' } });
		expect(await cache.process(files, background)).toEqual({ processed: 0, empty: 0, failed: 0 });
		expect(background.calls).toEqual([]);

		const manual = source({ 'photo.jpg': { text: 'now readable' } });
		expect(await cache.process(files, manual, undefined, undefined, true)).toEqual({ processed: 1, empty: 0, failed: 0 });
		expect(cache.pending(files, true)).toEqual([]);
	});

	it('re-reads an image that changed on disk', async () => {
		const cache = new ImageTextCache(fakeApp() as any, CACHE_PATH);
		await cache.process([image('a.png', 1, 10)], source({ 'a.png': { text: 'old' } }));
		expect(cache.pending([image('a.png', 2, 10)]).length).toBe(1);
		expect(cache.pending([image('a.png', 1, 11)]).length).toBe(1);
	});

	it('drops the "no text" entries an older cache file recorded for failed requests', async () => {
		const old = {
			version: 1,
			entries: {
				'good.png': { mtime: 1, size: 10, text: 'kept' },
				'failed.png': { mtime: 1, size: 10, text: '' },
			},
		};
		const app = fakeApp({ [CACHE_PATH]: JSON.stringify(old) });
		const cache = new ImageTextCache(app as any, CACHE_PATH);
		await cache.load();

		const files = [image('good.png'), image('failed.png')];
		expect(cache.pending(files).map((f) => f.path)).toEqual(['failed.png']);

		// Once saved in the new format, a real "no text" verdict survives a reload.
		await cache.process(files, source({}));
		const reloaded = new ImageTextCache(app as any, CACHE_PATH);
		await reloaded.load();
		expect(JSON.parse(app.files[CACHE_PATH]).version).toBe(2);
		expect(reloaded.pending(files)).toEqual([]);
	});
});
