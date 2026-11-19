import { App, MarkdownView, TFile, normalizePath } from 'obsidian';
import { VaultFileInfo, VaultPort } from '../vault/VaultPort';

function info(file: TFile): VaultFileInfo {
	return { path: file.path, basename: file.basename, extension: file.extension, mtime: file.stat.mtime, size: file.stat.size };
}

/** VaultPort over the real Obsidian vault. The only agent file that imports 'obsidian'. */
export class ObsidianVaultAdapter implements VaultPort {
	constructor(private readonly app: App) {}

	private fileAt(path: string): TFile {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`File not found: ${path}`);
		return file;
	}

	private async ensureFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf('/');
		if (slash <= 0) return;
		const folder = path.slice(0, slash);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
	}

	listFiles(): VaultFileInfo[] {
		return this.app.vault.getFiles().map(info);
	}

	getFile(path: string): VaultFileInfo | null {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		return file ? info(file) : null;
	}

	read(path: string): Promise<string> {
		return this.app.vault.cachedRead(this.fileAt(path));
	}

	async create(path: string, content: string): Promise<void> {
		const p = normalizePath(path);
		await this.ensureFolder(p);
		await this.app.vault.create(p, content);
	}

	async modify(path: string, content: string): Promise<void> {
		await this.app.vault.modify(this.fileAt(path), content);
	}

	async rename(from: string, to: string): Promise<void> {
		const target = normalizePath(to);
		await this.ensureFolder(target);
		// fileManager (not vault) so Obsidian rewrites links to the note.
		await this.app.fileManager.renameFile(this.fileAt(from), target);
	}

	async trash(path: string): Promise<void> {
		// Honours the user's "deleted files" preference (system or .trash).
		await this.app.fileManager.trashFile(this.fileAt(path));
	}

	getActiveNotePath(): string | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
	}

	getOpenNotePaths(): string[] {
		const paths = new Set<string>();
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const file = leaf.view instanceof MarkdownView ? leaf.view.file : null;
			if (file) paths.add(file.path);
		}
		return [...paths];
	}
}
