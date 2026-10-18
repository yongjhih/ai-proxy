# Design System — GitHub Primer for MCP Pages & ai-proxy

## Visual Direction & Surface Modes

Per the project specification, the web surfaces follow the **GitHub Primer** design system across **Read** (`index.html`, `zh-TW.html`, `doc.html`) and **Operate** (`dashboard.html`, `mcp.html`) modes:

- **Read Mode (`index.html`, `zh-TW.html`, `doc.html`)**: 68ch prose measure, clear typographic hierarchy, bordered tables, copy-ready command blocks with runtime URL substitution, and an unobtrusive slide-over "Ask AI" panel connected to local `/v1`.
- **Operate Mode (`dashboard.html`, `mcp.html`)**: Restrained developer console density, semantic connection badges, flat bordered ledger lists (`1px solid var(--border-default)`) instead of nested cards, and `tabular-nums` for ports, session IDs, and counters.

## Color Tokens (Light / Dark / System via `color-scheme`)

Theme state is controlled via `<meta name="color-scheme">` and `data-color-mode` (`system`, `light`, `dark`), respecting system preference by default:

| Token | Light Mode (`#ffffff` canvas) | Dark Mode (`#0d1117` canvas) | Role |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#ffffff` | `#0d1117` | Primary document background |
| `--bg-subtle` | `#f6f8fa` | `#161b22` | Header, sidebar, code block, and table header surface |
| `--bg-inset` | `#eff2f5` | `#010409` | Inset inputs and command output wells |
| `--fg-default` | `#1f2328` | `#e6edf3` | Primary body and heading text (≥ 12:1 contrast) |
| `--fg-muted` | `#59636e` | `#8b949e` | Secondary metadata and descriptions (≥ 4.6:1 contrast) |
| `--border-default` | `#d1d9e0` | `#30363d` | 1px structural dividers, tables, and list borders |
| `--accent-fg` | `#0969da` | `#4493f8` | Links, active navigation indicators, focus rings |
| `--accent-emphasis` | `#0969da` | `#1f6feb` | Primary action buttons |
| `--success-fg` | `#1a7f37` | `#3fb950` | Connected status and read-only tool badges |
| `--attention-fg` | `#9a6700` | `#d29922` | Standalone / awaiting-key and open-origin warnings |
| `--danger-fg` | `#d1242f` | `#f85149` | Mutating tool warnings, revoke/delete actions, errors |

## Typography & Hierarchy

- **UI & Prose Stack**: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`
- **Monospace Stack (strictly for code, URLs, ports, schemas, and JSON)**: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`
- **Scale (Fixed `rem`, 1.2 ratio)**:
  - `h1`: `1.75rem` (`28px`), `font-weight: 600`, `line-height: 1.25`
  - `h2`: `1.375rem` (`22px`), `font-weight: 600`, `line-height: 1.3`, bottom 1px rule on documentation headings
  - `h3`: `1.125rem` (`18px`), `font-weight: 600`, `line-height: 1.4`
  - Body: `0.9375rem` (`15px`), `line-height: 1.6`, `max-width: 68ch` for prose
  - UI Labels & Table Cells: `0.875rem` (`14px`), `font-variant-numeric: tabular-nums`

## Impeccable Craft Floor Commitments

- **No nested cards or icon-card grids**: Tool catalogs and site registries use Primer-style bordered list rows (`.Box` / `.Box-row`) with 1px structural borders.
- **No kickers/eyebrows, no gradient text, no >1px side borders**: Alerts and callouts use uniform `1px solid` borders with subtle semantic surface tints.
- **Authored SVG iconography**: All icons use 16×16 Octicon SVG paths (`currentColor`), never emoji or random Unicode symbols.
- **Themed browser surfaces**: Custom `::selection`, `caret-color`, `:focus-visible` (`2px solid var(--accent-fg)` with `2px` offset), and `text-underline-offset: 0.2em`.
