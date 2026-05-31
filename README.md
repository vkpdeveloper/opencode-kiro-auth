# opencode-kiro-auth

OpenCode plugin that adds Kiro as a provider, handles Kiro authentication, and routes OpenCode chat requests through the Kiro API.

Repository: `https://github.com/vkpdeveloper/opencode-kiro-auth`

## Features

- Adds a `kiro` provider to OpenCode
- Reuses existing Kiro IDE or `kiro-cli` credentials when available
- Supports AWS Builder ID device login
- Supports IAM Identity Center organization login
- Supports Google and GitHub login through `kiro-cli`
- Exposes Kiro models in OpenCode model selection
- Translates OpenAI-compatible chat requests into Kiro requests
- Translates Kiro streaming responses back into OpenAI-compatible chat output
- Supports reasoning effort levels including `low`, `medium`, `high`, `xhigh`, and `max`

## Requirements

- Node.js 20+
- Bun for local development and tests
- OpenCode installed and working locally

Optional:

- `kiro-cli` in your `PATH` for Google and GitHub login
- `sqlite3` installed if you want the plugin to reuse `kiro-cli` credentials from its local database

## Install In OpenCode

OpenCode supports two practical ways to load this plugin.

### Option 1: Local plugin file

Clone this repo, then either:

- place the plugin file in `.opencode/plugins/` for one project
- place the plugin file in `~/.config/opencode/plugins/` for all projects

Example:

```bash
git clone https://github.com/vkpdeveloper/opencode-kiro-auth.git
mkdir -p ~/.config/opencode/plugins
cp /path/to/opencode-kiro-auth/index.ts ~/.config/opencode/plugins/opencode-kiro-auth.ts
```

OpenCode will load the plugin automatically on startup.

### Option 2: Config path reference

If you prefer to keep the repo anywhere on disk and reference it directly, add it to `opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/oc-kiro-auth/index.ts"]
}
```

Example using this repo directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///Users/vaibhav/Developer/Personal/oc-kiro-auth/index.ts"]
}
```

Restart OpenCode after saving the config.

### Optional local plugin dependencies

If you load the plugin as a local TypeScript file, OpenCode expects dependencies to be available from your config directory. If needed, create `~/.config/opencode/package.json` or `.opencode/package.json` and install dependencies there.

Example:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.1.48"
  }
}
```

If you are just editing this repository itself, run `bun install` in this repo.

## Connect The Provider

Inside OpenCode:

1. Run `/connect`
2. Choose `Other`
3. Enter `kiro`
4. Choose one of the available auth methods

Available auth methods:

- `Auto / existing session`: reuses credentials from Kiro IDE or `kiro-cli` when found
- `AWS Builder ID`: starts the native AWS device flow
- `Your organization`: uses your IAM Identity Center start URL
- `Google via kiro-cli`: runs `kiro-cli login --license free`
- `GitHub via kiro-cli`: runs `kiro-cli login --license free`

## How Authentication Works

The plugin supports two main credential paths.

### 1. Reuse Existing Credentials

The plugin first tries to reuse credentials from:

- Kiro IDE token cache in `~/.aws/sso/cache/kiro-auth-token.json`
- `kiro-cli` local database
- older `codewhisperer` CLI token entries when present

This is the fastest path because no fresh browser login is required.

### 2. Run A New Login Flow

If reusable credentials are not available, the plugin can start a new login flow.

For Builder ID and organization login:

- the plugin registers a public OIDC client against AWS
- opens the verification URL in your browser
- polls for device authorization completion
- stores the resulting access and refresh token in OpenCode auth storage

For Google and GitHub login:

- the plugin shells out to `kiro-cli`
- waits for `kiro-cli` to complete login
- reads the resulting local social-login credentials

## Using Kiro Models

After connecting, select a Kiro model in OpenCode and chat normally.

The plugin currently exposes these Kiro-side model IDs through OpenCode:

- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-sonnet-4`
- `claude-haiku-4-5`
- `deepseek-3-2`
- `minimax-m2-1`
- `minimax-m2-5`
- `glm-5`
- `qwen3-coder-next`
- `auto`

## Reasoning Effort Support

The request transformer maps OpenCode `reasoning_effort` values to Kiro thinking budgets.

Supported values:

- `low`
- `medium`
- `high`
- `xhigh`
- `max`

## Local Development

Install dependencies:

```bash
bun install
```

Run the checks:

```bash
bun test
bun run typecheck
```

Build the distributable output:

```bash
bun run build
```

## Publish Your Own Fork

To publish your own public copy on GitHub with the GitHub CLI:

```bash
git init
git add .
git commit -m "Initial release"
gh repo create YOUR_USERNAME/opencode-kiro-auth --public --source=. --remote=origin --push
```

If you want to keep developing locally first, skip `--push` and push later with `git push -u origin main`.

## Manual Testing In OpenCode

Recommended smoke test:

1. Add the local plugin path to `opencode.json`
2. Restart OpenCode
3. Run `/connect` and connect `kiro`
4. Select a Kiro model such as `claude-sonnet-4-6`
5. Send a simple prompt such as `say hello`
6. Send a second prompt with tools enabled if you want to verify tool-call translation

Useful cases to test:

- auto credential reuse from an existing Kiro session
- Builder ID login on a clean machine
- organization login with a real IAM Identity Center start URL
- Google or GitHub login through `kiro-cli`
- a reasoning-heavy prompt with `reasoning_effort: max`

## Troubleshooting

### `kiro` does not appear in OpenCode

- confirm the plugin path in `opencode.json` is absolute and uses `file://`
- restart OpenCode after changing config
- confirm OpenCode can read `index.ts` from this repo

### Google or GitHub login does not work

- confirm `kiro-cli` is installed and available in `PATH`
- run `kiro-cli login --license free` manually once to verify the login flow works outside OpenCode

### Existing credentials are not detected

- confirm your Kiro IDE or `kiro-cli` session is still valid
- confirm `sqlite3` is installed if you expect reuse from `kiro-cli`
- try reconnecting through `/connect` to force a fresh auth flow

### Token refresh fails

- reconnect the `kiro` provider from OpenCode
- verify the underlying Kiro or AWS session is still active

## Project Status

Current scope:

- OpenAI-compatible chat request interception
- Kiro text and tool-call streaming
- credential reuse and refresh

Still worth improving:

- fuller parity with the original provider behavior around retries and profile discovery
- deeper coverage for image-heavy and long multi-turn agentic sessions

## License

MIT
