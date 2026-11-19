/**
 * Platform boundary for everything under src/agent/.
 *
 * Code in src/agent/ (except src/agent/obsidian/) must not import 'obsidian'
 * or touch the DOM. It only talks to the vault through this interface, which
 * keeps the agent, tools, MCP server and search testable in plain Node with an
 * in-memory vault. tests/agent/purity.test.ts enforces this.
 */
export interface VaultFileInfo {
	path: string;
	basename: string;
	extension: string;
	mtime: number;
	size: number;
}

export interface VaultPort {
	/** Every file in the vault (all extensions). */
	listFiles(): VaultFileInfo[];
	getFile(path: string): VaultFileInfo | null;
	read(path: string): Promise<string>;
	/** Creates parent folders as needed. Fails if the file exists. */
	create(path: string, content: string): Promise<void>;
	modify(path: string, content: string): Promise<void>;
	/** Moves or renames a file, creating parent folders as needed. */
	rename(from: string, to: string): Promise<void>;
	/** Moves a file to the trash (never a hard delete). */
	trash(path: string): Promise<void>;
	/** The note in the focused editor, if any. */
	getActiveNotePath?(): string | null;
	/** Notes open in editor tabs. */
	getOpenNotePaths?(): string[];
}

export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif']);

export function isMarkdown(file: { extension: string }): boolean {
	return MARKDOWN_EXTENSIONS.has(file.extension.toLowerCase());
}

export function isImage(file: { extension: string }): boolean {
	return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * Normalises a model-supplied path to a vault-relative path and rejects
 * anything that tries to leave the vault or touch config folders.
 */
export function normalizeVaultPath(input: string): string {
	if (typeof input !== 'string' || input.trim() === '') {
		throw new Error('A non-empty path is required');
	}
	const parts: string[] = [];
	for (const raw of input.replace(/\\/g, '/').split('/')) {
		const part = raw.trim();
		if (part === '' || part === '.') continue;
		if (part === '..') throw new Error(`Path must stay inside the vault: ${input}`);
		parts.push(part);
	}
	if (parts.length === 0) throw new Error(`Invalid path: ${input}`);
	if (parts[0].startsWith('.')) {
		throw new Error(`Hidden and config folders are off limits: ${input}`);
	}
	return parts.join('/');
}

/** Adds ".md" when a note path has no extension. */
export function withMarkdownExtension(path: string): string {
	const last = path.split('/').pop() ?? '';
	return last.includes('.') ? path : `${path}.md`;
}
