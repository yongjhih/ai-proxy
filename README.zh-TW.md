# ai-proxy · MCP Pages 開放規範與本機參考轉送

[![Coverage](https://yongjhih.github.io/ai-proxy/covpages/badge.svg)](https://yongjhih.github.io/ai-proxy/covpages/)
[![Specification](https://img.shields.io/badge/docs-specification-blue.svg)](https://yongjhih.github.io/ai-proxy/doc?d=zh-TW/spec)
[![Security](https://img.shields.io/badge/security-7%20baselines-success.svg)](https://yongjhih.github.io/ai-proxy/doc?d=zh-TW/security)
[![Devcontainer](https://img.shields.io/badge/devcontainer-ready-blue.svg)](.devcontainer/devcontainer.json)
[![Docker](https://img.shields.io/badge/docker-wrapper-informational.svg)](bin/ai-proxy-docker.mjs)

[English](./README.md) | [繁體中文](./README.zh-TW.md) · 🌐 **專案首頁**：[https://yongjhih.github.io/ai-proxy/zh-TW](https://yongjhih.github.io/ai-proxy/zh-TW) · 📊 **測試覆蓋率報告**：[https://yongjhih.github.io/ai-proxy/covpages/](https://yongjhih.github.io/ai-proxy/covpages/)

**MCP Pages** 是一份開放規範，讓任何純靜態網站（例如 GitHub Pages）不需後端伺服器，就能透過瀏覽器分頁內的 [WebMCP](https://webmachinelearning.github.io/webmcp/) 將工具提供給讀者的本機 AI 開發工具。

**`ai-proxy`** 是跑在讀者電腦上的零依賴 Node.js 參考轉送服務（預設監聽 `127.0.0.1:8788`），負責將 Claude Code、Cursor 等 MCP 客戶端安全地橋接至開啟靜態 MCP 頁的瀏覽器分頁。

## 架構總覽

```
AI 工具（Claude Code / MCP 客戶端）
  │
  │  Streamable HTTP POST /mcp?url=https://example.github.io/docs/mcp.html
  ▼
ai-proxy（127.0.0.1:8788）
  │
  │  長輪詢（/tab/v1/hello, /tab/v1/poll, /tab/v1/ack, /tab/v1/reply）
  ▼
瀏覽器分頁（https://example.github.io/docs/mcp.html 執行 navigator.modelContext）
```

- **分頁端模組（`web/*.mjs`）**：零依賴 ES modules（`url.mjs`、`handshake.mjs`、`model-context.mjs`、`dispatch.mjs`、`client.mjs`、`ui.mjs`、`index.mjs`），供靜態網站直接 vendor 進 repo。
- **本機轉送（`src/*.mjs`）**：零依賴 Node.js 伺服器，提供 `/mcp`（Streamable HTTP JSON-RPC 2.0）、`/tab/v1/*`（分頁長輪詢端點）、`/v1`（相容 OpenAI 的本機對話 API，強制逐一點名唯讀工具過濾）與 `/admin/v1/*`（儀表板管理 API）。
- **Pages 網站與儀表板（`index.html`, `zh-TW.html`, `doc.html`, `dashboard.html`, `mcp.html`）**：採用 GitHub Primer 設計系統（支援亮色、暗色、跟隨系統）、SPA 文件閱讀器、轉送狀態儀表板，以及內建 6 個工具（`about`、`sites`、`site_tools`、`spec`、`add_site`、`remove_site`）的示範 MCP 頁。

## 快速開始

```bash
# 1. 啟動本機 ai-proxy 轉送服務（預設監聽 127.0.0.1:8788）
npx ai-proxy serve

# 2. 將本站的 MCP 頁加入允許清單並註冊至 Claude Code
npx ai-proxy add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy-docs

# 3. 開啟帶管理金鑰的本機儀表板分頁
npx ai-proxy open dashboard
```

## 為你的靜態網站加上 MCP 頁

```bash
# 1. 將零依賴 WebMCP 前端模組匯出至你的靜態網站目錄
npx ai-proxy vendor ./web

# 2. 建立 mcp.html（或請 AI 助手讀取 skills/mcp-pages/SKILL.md 自動建立）
# 3. 執行 doctor 檢查確認符合所有規範
npx ai-proxy doctor --dir .
```

完整範例網站請見 [`examples/notes-site/`](./examples/notes-site/)。

## 共用 Origin（`<user>.github.io`）下的七條安全底線

同一個 GitHub 帳號或組織下的所有 `https://<user>.github.io/<repo>/` 網站共用**同一個瀏覽器 Origin**。`ai-proxy` 強制實作七條安全底線（詳見 [`docs/zh-TW/security.md`](./docs/zh-TW/security.md) 與 [`test/security-baselines.test.mjs`](./test/security-baselines.test.mjs)）：

1. **規則一（路徑邊界網址前綴允許清單）**：以正規化後的路徑片段邊界比對前綴（`https://example.github.io/docs/` 絕不匹配 `https://example.github.io/docs-evil/`）；`localhost` 與 `127.0.0.1` 一律允許。
2. **規則二（每頁獨立金鑰由 URL Fragment 移入 `history.state`）**：金鑰透過 `#mcp-key=...&mcp-port=...` 交給分頁，分頁讀取後立刻移入分頁專屬 `history.state` 並抹除網址列，絕不寫入 `localStorage`、`sessionStorage`、`IndexedDB` 或 cookie。
3. **規則三（`/mcp` 拒絕帶 `Origin` 的請求）**：任何帶有瀏覽器 `Origin` 標頭的 `POST /mcp` 請求一律回傳 `403 Forbidden`。
4. **規則四（`/v1` 僅開放逐一點名的唯讀工具）**：`/v1/chat/completions` 預設零工具；僅允許由 `--allow-tool mcp__<server>__<tool>` 逐一點名且 `annotations.readOnlyHint === true` 的工具。
5. **規則五（獨立管理金鑰與安全的 `open-dashboard` 交接）**：`/admin/v1/*` 使用獨立的 `adminKey`；唯一免金鑰路由 `POST /admin/v1/open-dashboard` 嚴格檢查儀表板 `Origin`、由本機打開新分頁、絕不在 HTTP 回應內回傳金鑰，並強制每 10 秒限速一次。
6. **規則六（修改狀態的工具強制標為非唯讀）**：新增或刪除網站的工具（`add_site`、`remove_site`）標為 `readOnlyHint: false`，讓 AI 客戶端呼叫前必須詢問使用者，且說明文字載明僅在使用者明確要求該網站時才可呼叫。
7. **規則七（`/v1` 萬用字元 `*` 限純聊天、自動過期與醒目警告）**：開放 `*` 時強制零工具（純聊天）、支援限時自動到期，並在儀表板與 CLI `stderr` 持續顯示警告。

## 規範文件

- [總覽與架構 (`docs/zh-TW/index.md`)](./docs/zh-TW/index.md) · [English (`docs/index.md`)](./docs/index.md)
- [MCP Pages 規範 (`docs/zh-TW/spec.md`)](./docs/zh-TW/spec.md) · [English (`docs/spec.md`)](./docs/spec.md)
- [轉送通訊協定 (`docs/zh-TW/protocol.md`)](./docs/zh-TW/protocol.md) · [English (`docs/protocol.md`)](./docs/protocol.md)
- [安全模型與威脅分析 (`docs/zh-TW/security.md`)](./docs/zh-TW/security.md) · [English (`docs/security.md`)](./docs/security.md)

## `.devcontainer` 與 `docker-wrapper` CLI 支援

### 1. `.devcontainer` 支援（`ai-proxy devcontainer`）

本專案內建 [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json) 與 [`.devcontainer/Dockerfile`](./.devcontainer/Dockerfile)，自動轉發 `8788` 埠、設定 `--add-host=host.docker.internal:host-gateway` 與 `AI_PROXY_HOST=host.docker.internal`，讓在容器內執行的 Claude Code 直接連上宿主机上的 `ai-proxy`。

你也可以透過 CLI 為任何專案初始化或操作 `.devcontainer`：

```bash
# 在任意專案產生或合併 .devcontainer/devcontainer.json
npx ai-proxy devcontainer init --dir .

# 啟動或在 devcontainer 內執行指令（自動注入 AI_PROXY_* 環境變數）
npx ai-proxy devcontainer up --dir .
npx ai-proxy devcontainer exec --dir . claude
```

### 2. `docker-wrapper` CLI（`ai-proxy-docker` / `docker-wrapper` / `ai-proxy docker`）

```bash
# 模式 A：以 Docker 容器執行 ai-proxy（若無映像檔會自動 docker build）
npx ai-proxy-docker serve --port 8788
npx ai-proxy-docker add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy-docs
npx ai-proxy-docker doctor --dir .

# 模式 B：包裝 docker run，讓容器內的 AI 工具（如 Claude Code）連回宿主機的 ai-proxy
npx ai-proxy-docker run -it my-agent-image claude
# 或透過主 CLI 呼叫：
npx ai-proxy docker-wrapper run -it my-agent-image claude
```

## 授權條款

[MIT](./LICENSE)
