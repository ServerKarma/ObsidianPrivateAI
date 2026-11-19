/**
 * Removes what the old embedding/vector-store pipeline left on disk.
 *
 * Every released version kept its index in a `vector-index` folder:
 * - v1.0.x early: `<configDir>/plugins/ObsidianPrivateAI/vector-index/embeddings.json`
 *   (later split into `text-embeddings.json` and `image-embeddings.json`)
 * - SQLite era:   `<configDir>/plugins/<manifest.id>/vector-index/embeddings.db`
 *
 * The folder name was hard-coded or built from the plugin id, which is not always the
 * folder the plugin is installed in, so all three candidate locations are checked.
 * Only the known index files are deleted; a folder is removed only once it is empty,
 * so nothing else that happens to live there is touched.
 */
export interface CleanupAdapter {
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
	stat?(path: string): Promise<{ size: number } | null>;
}

export const LEGACY_INDEX_FILES = [
	'embeddings.db',
	'embeddings.db-journal',
	'embeddings.db-wal',
	'embeddings.db-shm',
	'embeddings.json',
	'text-embeddings.json',
	'image-embeddings.json',
];

export interface CleanupResult {
	removedFiles: string[];
	removedFolders: string[];
	bytesFreed: number;
	errors: string[];
}

function baseName(path: string): string {
	return path.split('/').pop() ?? path;
}

export function legacyIndexFolders(configDir: string, pluginDir: string, pluginId: string): string[] {
	const folders = [
		`${pluginDir}/vector-index`,
		`${configDir}/plugins/${pluginId}/vector-index`,
		`${configDir}/plugins/ObsidianPrivateAI/vector-index`,
	];
	return [...new Set(folders.map((f) => f.replace(/\/+/g, '/')))];
}

export async function removeLegacyEmbeddingFiles(
	adapter: CleanupAdapter,
	opts: { configDir: string; pluginDir: string; pluginId: string },
): Promise<CleanupResult> {
	const result: CleanupResult = { removedFiles: [], removedFolders: [], bytesFreed: 0, errors: [] };
	const ownDir = opts.pluginDir.replace(/\/+$/, '');

	for (const folder of legacyIndexFolders(opts.configDir, opts.pluginDir, opts.pluginId)) {
		try {
			if (!(await adapter.exists(folder))) continue;
			const listing = await adapter.list(folder);
			for (const file of listing.files) {
				if (!LEGACY_INDEX_FILES.includes(baseName(file))) continue;
				const size = (await adapter.stat?.(file))?.size ?? 0;
				await adapter.remove(file);
				result.removedFiles.push(file);
				result.bytesFreed += size;
			}
			const after = await adapter.list(folder);
			if (after.files.length === 0 && after.folders.length === 0) {
				// Obsidian's non-recursive rmdir fails on directories (EISDIR), so recursive is
				// used, and only after checking the folder is empty.
				await adapter.rmdir(folder, true);
				result.removedFolders.push(folder);
				// A plugin folder that only ever held the index (created by the old
				// path bug) is removed too, but never this plugin's own folder.
				const parent = folder.slice(0, folder.lastIndexOf('/'));
				if (parent !== ownDir && (await adapter.exists(parent))) {
					const parentListing = await adapter.list(parent);
					if (parentListing.files.length === 0 && parentListing.folders.length === 0) {
						await adapter.rmdir(parent, true);
						result.removedFolders.push(parent);
					}
				}
			}
		} catch (error) {
			result.errors.push(`${folder}: ${(error as Error)?.message ?? error}`);
		}
	}
	return result;
}
