# Setup Guide

## Prerequisites

Before you can build and run this Obsidian plugin, you need to install Node.js and npm.

### Installing Node.js

1. **Download Node.js**: Visit [nodejs.org](https://nodejs.org/) and download the LTS version
2. **Install Node.js**: Run the installer and follow the setup wizard
3. **Verify Installation**: Open a new terminal/command prompt and run:
   ```bash
   node --version
   npm --version
   ```

### Alternative Installation Methods

#### Windows (using Chocolatey)
```bash
choco install nodejs
```

#### Windows (using Scoop)
```bash
scoop install nodejs
```

#### macOS (using Homebrew)
```bash
brew install node
```

#### Linux (using apt)
```bash
sudo apt update
sudo apt install nodejs npm
```

## Building the Plugin

Once Node.js and npm are installed:

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Build the Plugin**:
   ```bash
   npm run build
   ```

3. **Development Mode** (with hot reloading):
   ```bash
   npm run dev
   ```

## Installing in Obsidian

1. **Copy Files**: Copy the entire plugin folder to your Obsidian vault's `.obsidian/plugins/` directory
2. **Enable Plugin**: In Obsidian, go to Settings > Community Plugins and enable "Private AI"
3. **Configure Settings**: Go to the plugin settings and configure your local LLM endpoint

## Testing a Branch or Pull Request in Your Vault

`scripts/test-branch.mjs` builds any branch or pull request and drops it into a real vault in place of the installed plugin, so you can flip between branches and the community store version quickly. It works on Windows, macOS and Linux.

```bash
node scripts/test-branch.mjs --list          # open pull requests
node scripts/test-branch.mjs 64              # pull request #64
node scripts/test-branch.mjs my-branch       # any branch on origin
node scripts/test-branch.mjs --status        # what the vault is running now
node scripts/test-branch.mjs --restore       # back to the store version
```

Then reload Obsidian (command palette → "Reload app without saving"). If you use the Hot Reload plugin it reloads by itself.

- **Vault:** the script finds the vault that has Private AI installed from Obsidian's vault list. If there are several, pass `--vault "<path>"` once; it's remembered.
- **Your clone is never touched.** Builds happen in a separate git worktree next to the clone (`<clone>-test`), so uncommitted changes are safe. `npm ci` only reruns when `package-lock.json` changed. `--fast` skips the type check.
- **Store version and settings:** before the first switch, the installed version's files and `data.json` are copied to `~/.private-ai-test-branch/` (outside the vault, so it never syncs). `--restore` puts the files back and keeps your current settings; `--restore-settings` also puts `data.json` back.
- The dev build shows as "Private AI (dev: pr-64 @abc1234)" in Community plugins, so you can see what's loaded.

## Troubleshooting

### "npm is not recognized"
- Make sure Node.js is properly installed
- Restart your terminal/command prompt after installation
- Check that Node.js is added to your system PATH

### Build Errors
- Make sure all dependencies are installed: `npm install`
- Check that TypeScript is installed: `npm install -g typescript`
- Verify your Node.js version is compatible (v14 or higher recommended)

### Plugin Not Loading
- Check the Obsidian console for error messages
- Ensure all files are copied to the correct location
- Verify the plugin is enabled in Obsidian settings 