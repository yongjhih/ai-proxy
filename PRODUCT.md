# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Zero-dependency static HTML, CSS, and ES modules (`web/*.mjs`, `site/*`) published directly from the repository root on GitHub Pages (`.nojekyll`), paired with a zero-dependency Node.js (`>=20`) local HTTP relay (`src/*`, `bin/ai-proxy.mjs`).

## Users

1. **Static Site & Documentation Authors**: Engineers publishing documentation, technical guides, or static web apps on multi-tenant hosts like `<user>.github.io` who want to expose project-specific [WebMCP](https://github.com/webmachinelearning/webmcp) tools to readers' AI assistants without running a backend server.
2. **Developers Using Local AI Tools**: Readers running Claude Code, Cursor, or MCP-compatible clients on their workstation (`127.0.0.1:8788`) who connect static MCP Pages to query docs, inspect specifications, and run browser-hosted tools safely.

## Product Purpose

**MCP Pages** standardizes how any static website exposes client-side WebMCP tools to local AI coding assistants, and **`ai-proxy`** provides the reference local relay and management dashboard. Success means any static site can vendor `web/*.mjs` to become an MCP server in minutes while preserving strict path-level and per-page-key isolation on shared origins.

## Positioning

Unlike server-hosted MCP endpoints that require cloud compute or origin-trusting local bridges that fail when multiple projects share `<user>.github.io`, `ai-proxy` pairs path-boundary URL prefix allowlists with fragment-to-`history.state` per-page keys so neighboring repositories on the same origin cannot impersonate tabs or steal credentials.

## Operating Context

- Runs locally on developer workstations (`127.0.0.1:8788` by default, or ephemeral ports during testing) alongside terminal sessions and browser tabs.
- Serves three distinct surfaces:
  - **Read mode (`index.html`, `zh-TW.html`, `doc.html`)**: Specification, wire protocol, security model, copy-ready CLI commands with runtime base URL injection, and an interactive "Ask AI" drawer powered by local `/v1/chat/completions`.
  - **Operate mode (`dashboard.html`, `mcp.html`)**: Live relay status, connected site table, URL prefix allowlist controls, `/v1` origin controls, key rotation, and the interactive WebMCP tool catalog (`?tool=` direct read-only execution).

## Capabilities and Constraints

- Zero npm runtime dependencies in both browser modules (`web/*.mjs`) and Node.js relay (`src/*.mjs`).
- Seven mandatory security baselines enforced and tested (`docs/security.md`).
- Bilingual synchronization: English primary (`index.html`, `docs/*.md`) and Traditional Chinese (`zh-TW.html`, `docs/zh-TW/*.md`).
- Pinned visual direction from the specification: GitHub Primer design language with Light, Dark, and System color-scheme modes, plus SRI-pinned Mermaid diagrams via jsDelivr.

## Brand Commitments

- **GitHub Primer aesthetic** (explicitly mandated by specification): high-trust engineering documentation and developer console using Primer color tokens, borders, typography, and Octicon-style 16px SVG iconography.
- Open-source neutrality: all examples use `https://example.github.io/...` and self-referential commands resolve dynamically at runtime.

## Evidence on Hand

- Normative specifications in `docs/spec.md`, `docs/protocol.md`, `docs/security.md` (and `docs/zh-TW/*`).
- Reference browser modules in `web/*.mjs` and automated verification suites in `test/*.test.mjs`.

## Product Principles

1. **Specification as Single Source of Truth**: Every route, status code, and security invariant documented in `docs/` matches the implementation and its test suite 1:1.
2. **Hostile Neighbor Assumption**: Never trust `Origin` alone on shared static hosts; isolate secrets in `history.state` and verify path-aware URL prefixes.
3. **Zero-Dependency Longevity**: Plain ES modules and Node.js built-ins ensure static pages work forever on GitHub Pages without build pipelines or supply-chain churn.
4. **Earned Developer Familiarity**: Use disciplined GitHub Primer conventions—dense tabular data, clear semantic state badges, and immediate copy-ready commands—so engineers can audit and operate the relay at a glance.
