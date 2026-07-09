# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-09

### Added
- Initial release
- `glm-proxy.js` — Anthropic API ↔ GLM-5.2 bridge with prompt rewriting and tool conversion
- `windsurf-server.js` — OpenAI-compatible API server for Devin/Cognition models
- `windsurf-provider.js` — Connect-RPC protobuf client for server.codeium.com
- `windsurf.proto` — Reverse-engineered protobuf schema for Cognition API
- `setup.sh` — One-command setup with prerequisite checks
- `auto-start.sh` — macOS launchd auto-start configuration
- Support for 4 models: GLM-5.2, SWE-1.7, SWE-1.7 Lightning, Kimi K2.7
- Credential auto-refresh with file watcher and TTL cache
- Configurable ports via environment variables
- Documentation: getting Devin token, troubleshooting, architecture

### Known Limitations
- Devin CLI doesn't write refreshed tokens back to `credentials.toml`
- macOS-only auto-start (launchd)
- Streaming-focused (non-streaming not fully tested)
- Cognition API content filter may block some complex prompts
