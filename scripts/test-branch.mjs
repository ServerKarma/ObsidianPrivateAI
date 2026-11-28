#!/usr/bin/env node
/**
 * Try any branch or pull request of this plugin in your real Obsidian vault, and switch back
 * to the community store version when you're done.
 *
 *   node scripts/test-branch.mjs 64              # pull request #64
 *   node scripts/test-branch.mjs my-branch       # any branch on origin
 *   node scripts/test-branch.mjs main            # latest main
 *   node scripts/test-branch.mjs --list          # open pull requests
 *   node scripts/test-branch.mjs --status        # what the vault is running now
 *   node scripts/test-branch.mjs --restore       # put the store version back
 *
 * Options:
 *   --vault <path>       Vault folder. Remembered after the first use. If left out, the script
 *                        looks through Obsidian's vault list for one with Private AI installed.
 *   --fast               Skip the TypeScript type check (esbuild only).
 *   --restore-settings   With --restore, also put back data.json as it was before the first switch.
 *
 * How it stays out of your way:
 * - Your clone's working tree is never touched. Builds happen in a separate git worktree next to
 *   the clone (<clone>-test), so local edits and uncommitted changes are safe.
 * - npm ci only runs when package-lock.json changed since the last build, so switching is quick.
 * - The build replaces the installed plugin in place (same plugin id, same settings). Before the
 *   first switch, the store version's files and data.json are copied to a backup folder in your
 *   home directory (not in the vault, so it never syncs), and --restore copies them back.
 * - The plugin shows up in Obsidian as "Private AI (dev: <branch> @<sha>)" so you can see at a
 *   glance what's loaded. A .hotreload file is written so the Hot Reload plugin, if you use it,
 *   reloads automatically; otherwise run "Reload app without saving" from the command palette.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'private-ai';
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];
const MARKER = '.private-ai-dev.json';
const STATE_DIR = path.join(os.homedir(), '.private-ai-test-branch');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const isWindows = process.platform === 'win32';

function fail(message) {
	console.error(`\n✖ ${message}`);
	process.exit(1);
}

function step(message) {
	console.log(`\n▸ ${message}`);
}

function git(args, cwd, opts = {}) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })?.toString().trim();
}

function run(cmd, args, cwd) {
	// npm is a .cmd shim on Windows, which needs a shell to start.
	const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWindows });
	if (result.status !== 0) fail(`${cmd} ${args.join(' ')} failed (exit ${result.status ?? result.signal}).`);
}

function parseArgs(argv) {
	const opts = { target: null, vault: null, fast: false, list: false, status: false, restore: false, restoreSettings: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--vault') opts.vault = argv[++i];
		else if (a.startsWith('--vault=')) opts.vault = a.slice(8);
		else if (a === '--fast') opts.fast = true;
		else if (a === '--list') opts.list = true;
		else if (a === '--status') opts.status = true;
		else if (a === '--restore') opts.restore = true;
		else if (a === '--restore-settings') { opts.restore = true; opts.restoreSettings = true; }
		else if (a === '-h' || a === '--help') opts.help = true;
		else if (a.startsWith('-')) fail(`Unknown option ${a}. Run with --help.`);
		else if (opts.target) fail(`Only one branch or pull request at a time (got "${opts.target}" and "${a}").`);
		else opts.target = a;
	}
	if (!opts.vault && process.env.PRIVATE_AI_VAULT) opts.vault = process.env.PRIVATE_AI_VAULT;
	return opts;
}

/** "64", "#64", "pr/64", "pull/64" or a GitHub pull request URL → 64. Anything else is a branch. */
export function parseTarget(target) {
	const m = target.match(/^(?:#|pr\/?|pull\/)?(\d+)$/i) ?? target.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
	if (m) return { kind: 'pr', number: Number(m[1]), label: `pr-${m[1]}` };
	const branch = target.replace(/^origin\//, '');
	return { kind: 'branch', branch, label: branch };
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

function repoRoot() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	for (const dir of [process.cwd(), here]) {
		try {
			const top = git(['rev-parse', '--show-toplevel'], dir);
			// Use the main clone even when this copy of the script runs from inside the test worktree.
			const common = path.resolve(top, git(['rev-parse', '--git-common-dir'], top));
			return path.basename(common) === '.git' ? path.dirname(common) : top;
		} catch { /* try the next one */ }
	}
	fail('Run this from inside your clone of the plugin repository.');
}

function obsidianVaults() {
	const candidates = isWindows
		? [path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')]
		: [
			path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
			path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'obsidian', 'obsidian.json'),
			path.join(os.homedir(), '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
		];
	for (const file of candidates) {
		const data = readJson(file);
		if (data?.vaults) return Object.values(data.vaults).map((v) => v.path).filter(Boolean);
	}
	return [];
}

function resolveVault(opts) {
	const config = readJson(CONFIG_FILE) ?? {};
	let vault = opts.vault ?? config.vault;
	if (!vault) {
		const withPlugin = obsidianVaults().filter((v) => fs.existsSync(path.join(v, '.obsidian', 'plugins', PLUGIN_ID)));
		if (withPlugin.length === 1) {
			vault = withPlugin[0];
			console.log(`Found Private AI installed in vault ${vault}`);
		} else if (withPlugin.length > 1) {
			fail(`Private AI is installed in more than one vault. Pick one with --vault:\n  ${withPlugin.join('\n  ')}`);
		} else {
			fail('Could not find a vault with Private AI installed. Pass --vault "<path to your vault>" once and it will be remembered.');
		}
	}
	vault = path.resolve(vault);
	if (!fs.existsSync(path.join(vault, '.obsidian'))) fail(`${vault} doesn't look like an Obsidian vault (no .obsidian folder).`);
	if (config.vault !== vault) writeJson(CONFIG_FILE, { ...config, vault });
	return vault;
}

function backupDir(vault) {
	const key = createHash('sha256').update(vault.toLowerCase()).digest('hex').slice(0, 12);
	return path.join(STATE_DIR, `store-backup-${path.basename(vault).replace(/[^\w.-]/g, '_')}-${key}`);
}

function pluginDir(vault) {
	return path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
}

/** Copy the store version (and its settings) aside, once, before the first dev build lands. */
function backupStoreVersion(vault) {
	const dir = pluginDir(vault);
	const backup = backupDir(vault);
	if (fs.existsSync(path.join(dir, MARKER))) return; // A dev build is already installed; the backup is from before it.
	if (!fs.existsSync(path.join(dir, 'manifest.json'))) return; // Nothing installed yet.
	fs.rmSync(backup, { recursive: true, force: true });
	fs.mkdirSync(backup, { recursive: true });
	for (const f of [...PLUGIN_FILES, 'data.json']) {
		if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(backup, f));
	}
	const version = readJson(path.join(backup, 'manifest.json'))?.version ?? 'unknown';
	writeJson(path.join(backup, 'backup.json'), { vault, version, savedAt: new Date().toISOString() });
	console.log(`Saved the installed version ${version} and its settings to ${backup}`);
}

function ensureWorktree(repo) {
	const worktree = `${repo}-test`;
	const listed = git(['worktree', 'list', '--porcelain'], repo)
		.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
	if (listed.some((p) => p.toLowerCase() === path.resolve(worktree).toLowerCase())) return worktree;
	if (fs.existsSync(worktree)) {
		fail(`${worktree} exists but isn't a worktree of ${repo}. Move it out of the way and run again.`);
	}
	git(['worktree', 'prune'], repo);
	step(`Creating build worktree at ${worktree} (your clone stays untouched)`);
	git(['worktree', 'add', '--detach', worktree], repo, { inherit: true });
	return worktree;
}

function fetchTarget(repo, target) {
	const ref = target.kind === 'pr' ? `refs/pull/${target.number}/head` : `refs/heads/${target.branch}`;
	step(`Fetching ${target.kind === 'pr' ? `pull request #${target.number}` : `branch ${target.branch}`}`);
	try {
		git(['fetch', '--no-tags', 'origin', ref], repo);
	} catch (e) {
		fail(`Couldn't fetch ${ref} from origin. ${String(e.stderr ?? e.message).trim()}`);
	}
	return git(['rev-parse', 'FETCH_HEAD'], repo);
}

function installDependencies(worktree) {
	const lock = path.join(worktree, 'package-lock.json');
	const hash = createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
	const stamp = path.join(worktree, 'node_modules', '.test-branch-lock-hash');
	if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) {
		console.log('Dependencies unchanged, skipping npm ci.');
		return;
	}
	step('Installing dependencies (package-lock.json changed)');
	run('npm', ['ci', '--no-audit', '--no-fund'], worktree);
	fs.writeFileSync(stamp, hash);
}

function install(vault, worktree, target, sha) {
	const dir = pluginDir(vault);
	fs.mkdirSync(dir, { recursive: true });
	for (const f of PLUGIN_FILES) {
		const src = path.join(worktree, f);
		if (f === 'manifest.json') continue;
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
		else if (f === 'main.js') fail('The build did not produce main.js.');
		else fs.rmSync(path.join(dir, f), { force: true });
	}
	const manifest = readJson(path.join(worktree, 'manifest.json'));
	if (!manifest || manifest.id !== PLUGIN_ID) fail(`manifest.json on this branch has id "${manifest?.id}", expected "${PLUGIN_ID}".`);
	manifest.name = `Private AI (dev: ${target.label} @${sha.slice(0, 7)})`;
	writeJson(path.join(dir, 'manifest.json'), manifest);
	writeJson(path.join(dir, MARKER), { target: target.label, sha, version: manifest.version, installedAt: new Date().toISOString() });
	fs.writeFileSync(path.join(dir, '.hotreload'), '');
}

function status(vault) {
	const dir = pluginDir(vault);
	const marker = readJson(path.join(dir, MARKER));
	const manifest = readJson(path.join(dir, 'manifest.json'));
	const backup = readJson(path.join(backupDir(vault), 'backup.json'));
	console.log(`Vault:    ${vault}`);
	if (marker) console.log(`Running:  dev build of ${marker.target} @${marker.sha.slice(0, 7)} (installed ${marker.installedAt})`);
	else if (manifest) console.log(`Running:  store version ${manifest.version}`);
	else console.log('Running:  Private AI is not installed in this vault');
	if (backup) console.log(`Backup:   store version ${backup.version}, saved ${backup.savedAt}`);
}

async function restore(vault, restoreSettings) {
	const dir = pluginDir(vault);
	const backup = backupDir(vault);
	if (!fs.existsSync(path.join(dir, MARKER))) {
		console.log('The vault is already running the store version. Nothing to restore.');
		return;
	}
	if (fs.existsSync(path.join(backup, 'manifest.json'))) {
		for (const f of PLUGIN_FILES) {
			const src = path.join(backup, f);
			if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
			else fs.rmSync(path.join(dir, f), { force: true });
		}
		if (restoreSettings && fs.existsSync(path.join(backup, 'data.json'))) {
			fs.copyFileSync(path.join(backup, 'data.json'), path.join(dir, 'data.json'));
			console.log('Settings (data.json) restored to how they were before the first switch.');
		}
		console.log(`Restored store version ${readJson(path.join(backup, 'backup.json'))?.version ?? ''}.`);
	} else {
		// No backup (the plugin wasn't installed before the first switch): fetch the latest release instead.
		step('No backup found, downloading the latest release from GitHub');
		const repoSlug = githubSlug(repoRoot());
		const res = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, { headers: { 'User-Agent': 'private-ai-test-branch' } });
		if (!res.ok) fail(`GitHub answered ${res.status} for the latest release.`);
		const release = await res.json();
		for (const f of PLUGIN_FILES) {
			const asset = release.assets?.find((a) => a.name === f);
			if (!asset) { fs.rmSync(path.join(dir, f), { force: true }); continue; }
			const file = await fetch(asset.browser_download_url);
			if (!file.ok) fail(`Download of ${f} failed (${file.status}).`);
			fs.writeFileSync(path.join(dir, f), Buffer.from(await file.arrayBuffer()));
		}
		console.log(`Installed release ${release.tag_name}.`);
	}
	fs.rmSync(path.join(dir, MARKER), { force: true });
	fs.rmSync(path.join(dir, '.hotreload'), { force: true });
	console.log('Reload Obsidian (command palette → "Reload app without saving") to switch back.');
}

function githubSlug(repo) {
	const url = git(['remote', 'get-url', 'origin'], repo);
	const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
	if (!m) fail(`origin (${url}) is not a GitHub repository.`);
	return m[1];
}

async function listPullRequests(repo) {
	let prs = null;
	try {
		const res = await fetch(`https://api.github.com/repos/${githubSlug(repo)}/pulls?state=open&per_page=50`, { headers: { 'User-Agent': 'private-ai-test-branch' } });
		if (res.ok) prs = await res.json();
		else console.log(`GitHub answered ${res.status} (rate limit?), listing branches from git instead.`);
	} catch (e) {
		console.log(`Couldn't reach the GitHub API (${e.message}), listing branches from git instead.`);
	}
	if (prs) {
		if (prs.length === 0) console.log('No open pull requests.');
		for (const pr of prs) console.log(`  #${String(pr.number).padEnd(4)} ${pr.title}  (${pr.head.ref})`);
		console.log(`\nTry one with: ${self()} <number>`);
		return;
	}
	const heads = git(['ls-remote', '--heads', 'origin'], repo).split('\n').map((l) => l.split('refs/heads/')[1]).filter(Boolean);
	for (const h of heads) console.log(`  ${h}`);
	console.log(`\nTry one with: ${self()} <branch or pull request number>`);
}

/** How to run this script again, as typed from the current folder. */
function self() {
	const rel = path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'test-branch.mjs';
	return `node ${rel.includes(' ') ? `"${rel}"` : rel}`;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || (!opts.target && !opts.list && !opts.status && !opts.restore)) {
		const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
		console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
		return;
	}
	const repo = repoRoot();
	if (opts.list) return listPullRequests(repo);
	const vault = resolveVault(opts);
	if (opts.status) return status(vault);
	if (opts.restore) return restore(vault, opts.restoreSettings);

	const started = Date.now();
	const target = parseTarget(opts.target);
	const sha = fetchTarget(repo, target);
	const worktree = ensureWorktree(repo);
	step(`Checking out ${sha.slice(0, 7)} in the build worktree`);
	git(['checkout', '--force', '--detach', sha], worktree);
	// Drop build output and stray files from the previous branch, but keep node_modules for speed.
	git(['clean', '-fdx', '-e', 'node_modules'], worktree);
	installDependencies(worktree);
	step(opts.fast ? 'Building (esbuild only)' : 'Building (type check + esbuild)');
	if (opts.fast) run('node', ['esbuild.config.mjs', 'production'], worktree);
	else run('npm', ['run', 'build'], worktree);
	backupStoreVersion(vault);
	install(vault, worktree, target, sha);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	console.log(`\n✔ ${target.label} @${sha.slice(0, 7)} is installed in ${vault} (${seconds}s).`);
	console.log('  Reload Obsidian: command palette → "Reload app without saving" (or Hot Reload picks it up).');
	console.log(`  Back to the store version: ${self()} --restore`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e) => fail(e?.message ?? String(e)));
}
