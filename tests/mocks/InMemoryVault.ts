import { VaultFileInfo, VaultPort } from '../../src/agent/vault/VaultPort';

interface Entry {
	content: string;
	mtime: number;
}

/** VaultPort over a Map, for testing the agent stack without Obsidian. */
export class InMemoryVault implements VaultPort {
	readonly files = new Map<string, Entry>();
	readonly trashed: string[] = [];
	active: string | null = null;
	open: string[] = [];
	private clock = 1_700_000_000_000;

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.set(path, content);
	}

	set(path: string, content: string): void {
		this.clock += 1000;
		this.files.set(path, { content, mtime: this.clock });
	}

	private info(path: string, e: Entry): VaultFileInfo {
		const name = path.split('/').pop() ?? path;
		const dot = name.lastIndexOf('.');
		return {
			path,
			basename: dot > 0 ? name.slice(0, dot) : name,
			extension: dot > 0 ? name.slice(dot + 1) : '',
			mtime: e.mtime,
			size: e.content.length,
		};
	}

	listFiles(): VaultFileInfo[] {
		return [...this.files.entries()].map(([p, e]) => this.info(p, e));
	}

	getFile(path: string): VaultFileInfo | null {
		const e = this.files.get(path);
		return e ? this.info(path, e) : null;
	}

	async read(path: string): Promise<string> {
		const e = this.files.get(path);
		if (!e) throw new Error(`File not found: ${path}`);
		return e.content;
	}

	async create(path: string, content: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
		this.set(path, content);
	}

	async modify(path: string, content: string): Promise<void> {
		if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
		this.set(path, content);
	}

	async rename(from: string, to: string): Promise<void> {
		const e = this.files.get(from);
		if (!e) throw new Error(`File not found: ${from}`);
		this.files.delete(from);
		this.set(to, e.content);
	}

	async trash(path: string): Promise<void> {
		if (!this.files.delete(path)) throw new Error(`File not found: ${path}`);
		this.trashed.push(path);
	}

	getActiveNotePath(): string | null {
		return this.active;
	}

	getOpenNotePaths(): string[] {
		return this.open;
	}
}
