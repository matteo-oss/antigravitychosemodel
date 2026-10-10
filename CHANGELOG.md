# Changelog

Release history preserved from the project README. Historical entries describe the behavior of their release; see [compatibility and recovery](docs/compatibility.md) for current installation guidance.

### Unreleased — Tool failure feedback

- Preserve explanatory text beside tool results when converting conversation history for OpenAI-compatible and Anthropic providers. An empty tool result no longer hides an error sent in a sibling text part.
- Keep tool replies grouped before accompanying feedback and preserve OpenAI assistant text beside tool calls. HTTP regressions verify that a later model request receives the failure and can correct the call.
- Apply the same feedback preservation to the optional gateway and retain declared JSON-schema constraints, including `parametersJsonSchema`, when forwarding its tools to providers.

### Unreleased — File-tool parameter preservation

- Fix a proxy bug matching [issue #7](https://github.com/vahapogut/antigravity-add-model/issues/7): valid file-writing calls could acquire an undeclared `AbsolutePath` argument and be rejected repeatedly.
- Preserve unknown/custom tool arguments, prefer each request's declared schema over historical parameter names, and resolve only explicit aliases without guessing paths from file content or descriptions.
- Apply the fix to OpenAI-compatible and Anthropic JSON/streaming responses, retain `parametersJsonSchema` declarations, and keep schema state isolated between concurrent requests.

### Unreleased — More providers and searchable catalogs

- Add desktop and gateway presets for Together AI, Hugging Face Inference Providers, SambaNova, SiliconFlow, Novita AI, and Alibaba Cloud Model Studio.
- Add gateway routing for DeepSeek, Mistral, xAI, Cerebras, and Fireworks AI, with provider settings and selectors generated from one gateway catalog.
- Add model-catalog search, filtered bulk selection, and import of available context/output limits and image/reasoning metadata without replacing explicit overrides.
- Handle provider-specific model listing, including Together's array response and paginated DashScope and Fireworks catalogs; filter unsupported model types and preserve exact model IDs.
- Document [provider endpoints and setup](docs/providers.md). Model availability, billing, and tool capabilities remain provider- and account-dependent.

### Unreleased — Model management and optional gateway

- Add grouped model editing, duplication, enable/disable, provider/local discovery, JSON/base64 import, and credential-redacted export.
- Add explicit protocols, request overrides, fallback chains, circuit breakers, and aggregate diagnostics.
- Add opt-in Google account sign-in with a user-owned OAuth client, encrypted account storage, token refresh, pool selection, and explicit quota checks.
- Add a separate authenticated gateway with provider-priority routing, web dashboard, SQLite history, replay, pricing estimates, and optional context compaction.
- Add saved remote gateway connections, authenticated alias import, and a read-only Doctor command while retaining vendor runtime hooks and transactional deployment.
- See [feature parity and boundaries](docs/feature-parity.md) for pinned source comparisons and verification limits.

### Unreleased — Antigravity 2.17.0 compatibility
- Reproduced the Windows black screen as `ERR_CERT_AUTHORITY_INVALID` with the old runtime overlay.
- Preserve the installed vendor runtime, including its certificate handling, WSL bridge, updater, and host bridge; add custom-model support through validated hooks.
- Recover recorded overlay installations from verified originals and reject unfamiliar runtime layouts before changing application files.
- Verified local UI startup with the official Windows 2.17.0 executable and language server in an isolated test profile. Authenticated model generation was not tested.

### v2.1.1
- **Critical Fix**: Fixed a startup crash (`a.getState is not a function`) when launching with Antigravity v2.12.2.
- **Architecture**: Removed a hardcoded 500ms page reload during startup that interrupted the Antigravity frontend's state hydration.
- **Compatibility**: Injected missing ContextBridge APIs (`getState`, `showOpenMultipleFolderDialog`, `revealInFilePicker`, `ideAPI`) into `preload.ts` that were introduced in Antigravity v2.12 and are required by the newer frontend renderer.

### v2.1.0
- **TypeScript**: Full migration — all 23 source files converted from JavaScript to TypeScript (`dist/*.js` → `src/*.ts`)
- **New Provider**: OpenRouter support (300+ models via unified API, OpenAI-compatible format)
- **OpenRouter UI**: Provider dropdown, auto-filled URL, connection test, icon & color in Settings modal
- **Dev Experience**: ESLint + Prettier configured with automated `lint`, `format`, `lint:fix` scripts
- **Test Coverage**: Expanded to 137 tests across 6 test files (registry, proxy, modelUtils, translators)
- **Cleanup**: Removed 25+ scratch development artifacts, added `.prettierignore`
- **Architecture**: `ideInstall/` wizard extracted to dedicated TypeScript module

### v2.0.3
- **Architecture**: Extracted Google AI Studio translator to dedicated module
- **Architecture**: Managed proxy state cleanup with proper interval lifecycle
- **New**: Model connectivity test in Settings (green/red status indicator)
- **New**: Automatic request retry with exponential backoff (429/5xx)
- **New**: Configurable `maxRetries` per model
- **Security**: Removed automatic SSL bypass for custom providers
- **Security**: Added 10MB request body size limit (413 on overflow)
- **Security**: Masked CSRF token in console output
- **Security**: Added timeouts to all Google proxy requests (30-60s)
- **Error handling**: Added debug logging to 6 previously-silent catch blocks
- **Error handling**: Proper error propagation in streaming response handlers
- **Fixed**: `deploy.ps1` now uses `$PSScriptRoot` (portable, no hardcoded paths)
- **Documentation**: Updated README with TypeScript architecture, security defaults, troubleshooting
- **Package**: Added `Apache-2.0` license field to `package.json`

### v2.0.2
- **Security**: Replaced `eval()` with safe `repairPartialJson()` (code injection fix)
- **Security**: SSL bypass now only when `allowUnauthorized: true` (not all custom providers)
- **Security**: Removed diagnostic `api_response_raw.json` disk writes
- **Security**: Added 10MB request body size limit
- **Security**: Added 120s configurable API request timeout
- **Error handling**: Added error handlers for streaming and non-streaming API responses
- **Fixed**: `deploy.ps1` hardcoded path to now uses `$PSScriptRoot`
- **Documentation**: Added Security Considerations, Troubleshooting, and Developer Guide

### v2.0.2 (2026-05-24)
- **Critical fix**: Antigravity v2.0.6 update hardcoded `fetchAvailableModels` URL to `daily-cloudcode-pa.googleapis.com`, bypassing the local proxy. Custom models disappeared from the chat dropdown.
- **Binary patch**: The Language Server binary is now automatically patched at build time to replace the hardcoded Google URL with the local proxy URL.
- **URL padding handler**: Added regex-based URL cleanup in the proxy to strip binary patch padding.
- **Model API fallbacks**: Added `GetAvailableModels` redirect, preload network interceptors, and forced page reload for robust model loading across Antigravity versions.

### v2.0.0
- Initial release: multi-provider proxy, API key encryption, streaming, tool calls, custom UI
