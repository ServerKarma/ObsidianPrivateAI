/**
 * Folder and file-pattern exclusions (settings: excludedFolders,
 * excludedFilePatterns). Excluded files are invisible to search, grep,
 * listing and reading.
 */
export interface ExclusionRules {
	excludedFolders?: string[];
	excludedFilePatterns?: string[];
}

function clean(entries: string[] | undefined): string[] {
	return (entries ?? [])
		.map((e) => e.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter((e) => e.length > 0);
}

function wildcardToRegExp(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				out += '.*';
				i++;
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else {
			out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`, 'i');
}

export function isExcluded(path: string, rules: ExclusionRules | undefined): boolean {
	if (!rules) return false;
	const filePath = path.replace(/\\/g, '/');
	const lower = filePath.toLowerCase();
	const fileName = filePath.split('/').pop() ?? filePath;
	const dot = fileName.lastIndexOf('.');
	const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';

	for (const folder of clean(rules.excludedFolders)) {
		if (folder.includes('*') || folder.includes('?')) {
			const re = wildcardToRegExp(folder);
			const reDeep = wildcardToRegExp(`${folder}/**`);
			if (re.test(filePath) || reDeep.test(filePath)) return true;
		} else {
			const f = folder.toLowerCase();
			if (lower === f || lower.startsWith(f + '/')) return true;
		}
	}

	for (const pattern of clean(rules.excludedFilePatterns)) {
		const p = pattern.toLowerCase();
		if (p.startsWith('*.') && ext === p.slice(1)) return true;
		if (p.startsWith('.') && ext === p) return true;
		if (p.includes('*') || p.includes('?')) {
			const re = wildcardToRegExp(pattern);
			if (re.test(filePath) || re.test(fileName)) return true;
			continue;
		}
		if (lower === p || lower.endsWith('/' + p) || fileName.toLowerCase() === p || ext === '.' + p) return true;
	}
	return false;
}
