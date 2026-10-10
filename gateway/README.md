# Antigravity Model Gateway

Optional provider router and web dashboard for `antigravity-add-model`. Requires
Node.js **22.13 or newer** for built-in SQLite. From the repository directory:

```sh
npm --prefix gateway ci
npm --prefix gateway run build
node gateway/dist/cli.js setup --non-interactive
node gateway/dist/cli.js start
```

Setup prints the generated gateway token and dashboard login locally. Open
`http://127.0.0.1:51001`, enter those credentials, configure provider keys and
model mappings, then save. `setup` without `--non-interactive` also offers a
provider/key prompt. `start --foreground` runs in the current terminal.

## Connect the desktop addon

Use the desktop **Import Gateway Models** action with URL
`http://127.0.0.1:51000` and the generated gateway token. Imported aliases use
the Google provider because this gateway accepts native Gemini requests and
returns native Gemini JSON or SSE. A manual entry uses the same URL, the token
as its API key, and the gateway alias as its external model name.

Authenticated endpoints accept `Authorization: Bearer <token>` or
`x-goog-api-key: <token>`:

| Endpoint | Result |
| --- | --- |
| `GET /health` | Public, minimal service health |
| `GET /models` or `/v1beta/models` | Alias metadata for desktop import |
| `POST /v1beta/models/<alias>:generateContent` | Native Gemini JSON |
| `POST /v1beta/models/<alias>:streamGenerateContent?alt=sse` | Native Gemini SSE |

Set `x-antigravity-conversation-id` to group requests into one history session.
Otherwise each request receives its own session ID. Both generation modes
support text, reasoning, tools, images supported by the selected provider,
and generation settings. Routing retries end once response content has been
sent to the client.

## Routing and dashboard

The dashboard includes provider priority ordering, per-model provider mappings,
model fallback chains, live provider model discovery, local service discovery,
reasoning settings, context windows, request history, search, replay, sessions,
estimated costs, pricing overrides, blocklists, rate limits, and failover webhooks.
Charts are bundled and work offline. Local discovery only runs when requested.

Provider adapters cover OpenAI-compatible chat, Anthropic messages, Google
Gemini, and OpenCode Zen/Go chat, messages, and Responses protocols. Presets
include OpenAI, Anthropic, Google, OpenRouter, Together AI, Hugging Face Inference
Providers, SambaNova, SiliconFlow, Novita AI, Alibaba Cloud Model Studio,
DeepSeek, Mistral, xAI, Cerebras, Fireworks AI, NVIDIA, Groq, Ollama, LM Studio,
vLLM, OpenCode Zen, and OpenCode Go. Configure keys as `<PROVIDER>_API_KEY` and optional custom endpoints
as `<PROVIDER>_BASE_URL`; Zen uses `OPENCODE_API_KEY` / `OPENCODE_BASE_URL`,
and Go uses `OPENCODE_GO_API_KEY` / `OPENCODE_GO_BASE_URL`.

Dashboard provider forms, routing selectors, and **Browse Models** use the same
[provider catalog](src/provider-catalog.ts). Save a provider key in **Config**,
then browse its live models and map the desired IDs to aliases. Base URL
overrides are optional; clearing an override restores its preset default.
Saved keys remain masked and leaving a key field empty preserves it. See
[provider setup and endpoints](../docs/providers.md) for exact IDs, endpoint
formats, and regional/account requirements.

For example, this `models.json` routes an alias to two OpenAI models in order:

```json
{
  "_routing_mode": "priority-chain",
  "_global_provider_priority": ["openai"],
  "_provider_models": {
    "my-model": { "openai": ["your-primary-model", "your-fallback-model"] }
  },
  "_context_windows": { "my-model": 128000 },
  "_model_capabilities": {
    "my-model": { "supportsVision": false, "supportsThinking": false }
  },
  "_compaction_enabled": false
}
```

Imported aliases advertise the configured context window (128,000 by default).
Vision and thinking default to false because an alias can route to different
providers. Set explicit `_model_capabilities` flags only when every intended
route supports them, or edit the imported model's overrides in the desktop.

Context passes through unchanged by default. Optional `strip` / `lite` modes
remove supported editor context sections; optional LLM compaction summarizes
older turns once a configured context threshold is reached. Compaction makes
an additional provider request and preserves recent turns and tool exchanges.
Configure these in the dashboard before enabling them.

## Lifecycle and data

```sh
node gateway/dist/cli.js status
node gateway/dist/cli.js config
node gateway/dist/cli.js config set OPENAI_API_KEY your-key
node gateway/dist/cli.js config get AG_GATEWAY_TOKEN
node gateway/dist/cli.js logs
node gateway/dist/cli.js stop
```

The default profile is `~/.gemini/antigravity/gateway`. Set
`AG_GATEWAY_DATA_DIR` before launching to use another profile. Configuration,
SQLite history, model maps, prices, and logs stay in that profile. The default
`config` listing masks secrets; `config get KEY` deliberately prints that value.
Settings saved through the dashboard reload immediately. After CLI edits, use
dashboard Reload or restart; listener address/port changes always need restart.

History contains prompts, responses, and tool arguments. Delete requests or
sessions through the dashboard when no longer needed. Replay uses the complete
saved request, including system instructions, tools, and generation settings,
and can target another configured alias. Each replay is a new request and uses
current routing, limits, and context settings. Older entries without a request
snapshot cannot be replayed. Token counts and prices
are estimates; edit pricing to match your provider. Bundled provider/model
examples and price tables do not guarantee availability or billing rates.

## Remote access

Both listeners bind to loopback by default. Access them through an SSH tunnel,
or explicitly enable a network listener:

```sh
node gateway/dist/cli.js config set AG_GATEWAY_REMOTE true
node gateway/dist/cli.js config set AG_GATEWAY_HOST 0.0.0.0
node gateway/dist/cli.js stop
node gateway/dist/cli.js start
```

Generation still requires the token and the dashboard still requires login.
The gateway serves HTTP; use a trusted HTTPS reverse proxy or encrypted tunnel
when traffic crosses an untrusted network. It does not install certificates,
change DNS/hosts, require administrator access, or manage the desktop process.

## Validation and provenance

```sh
npm --prefix gateway run build
npm --prefix gateway test
```

Tests use isolated profiles and local mock providers, including real HTTP
generation, dashboard authentication, SQLite persistence, failover, compaction,
and background CLI lifecycle. Live paid-provider credentials are not required.

Adapted MIT components and their pinned source revision are documented in
[UPSTREAM.md](UPSTREAM.md); the original license is retained in
[LICENSE.upstream](LICENSE.upstream). The bundled chart library retains its
license in `dashboard/vendor/LICENSE.chartjs.md`.
