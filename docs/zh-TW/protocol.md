# 通訊協定規格（Wire Protocol）

本文件詳列 `ai-proxy`（預設 `127.0.0.1:8788`）與瀏覽器分頁（`web/*.mjs`）、AI 工具、網頁對話端及儀表板之間的每一個 HTTP 請求、回應、標頭與錯誤碼。

---

## 1. 瀏覽器 CORS 與 Chrome Local Network Access 規則

由於託管在 `https://<user>.github.io` 的網頁會向本機 `http://127.0.0.1:8788` 發送跨來源請求，`ai-proxy` 在所有給瀏覽器呼叫的路由（`/tab/v1/*`、`/v1/*`、`/admin/v1/*`、`/healthz`）上，**即使是拒絕或錯誤的回應（`400`、`401`、`403`、`404`、`409`、`429`、`500`、`502`、`504`）也必須加上 CORS 標頭**。否則瀏覽器只會拋出無法區分的網路錯誤，讓網頁分不出「`ai-proxy` 沒開」還是「被 `ai-proxy` 拒絕」。

### 瀏覽器路由必備回應標頭
當請求帶有 `Origin` 標頭時：
```http
Access-Control-Allow-Origin: <請求的 Origin>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-AI-Proxy-Confirm
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age: 600
```

### `OPTIONS` 預檢請求與私有網路存取（Local Network Access）
當 Chrome 發送帶有 `Access-Control-Request-Private-Network: true` 的 `OPTIONS` preflight 時，`ai-proxy` 直接回傳 `204 No Content` 與上述標頭。

### 存活探測（`GET /healthz` 或 `GET /tab/v1/probe`）
尚未持有金鑰的網頁可用 `fetch("http://127.0.0.1:8788/healthz", { mode: "no-cors" })` 探測 `ai-proxy` 是否有在跑。
- **回應（`200 OK`）**：
  ```json
  { "ok": true, "service": "ai-proxy", "version": "1.0.0" }
  ```

---

## 2. MCP Streamable HTTP 端點（`/mcp`）

AI 工具透過 Streamable HTTP（僅回傳 JSON）連線至 `ai-proxy`。

### 2.1 兩種網址寫法
1. **查詢參數形式**：`POST /mcp?url=https%3A%2F%2Fexample.github.io%2Fdocs%2Fmcp.html`
2. **路徑形式**：`POST /mcp/example.github.io/docs/mcp.html`（預設為 `https://`，若 host 為 `localhost` 或 `127.0.0.1` 則為 `http://`）

### 2.2 `/mcp` 的安全與協定檢查
| 條件 | HTTP 狀態碼 | 回應內容 | 原因 |
| :--- | :--- | :--- | :--- |
| 請求帶有 `Origin` 標頭 | `403 Forbidden` | `{"error":"Origin header is not allowed on /mcp"}` | 禁止任何網頁直接當成 MCP 客戶端呼叫工具 |
| `GET /mcp...`（嘗試開啟 SSE） | `405 Method Not Allowed` | `{"error":"SSE GET not supported; use POST"}`（含 `Allow: POST`） | Claude Code 會用 GET 探測 SSE，回 405 讓它改用單純 JSON POST |
| 缺少或無效的目標網址 | `400 Bad Request` | `{"error":"Invalid or missing target URL"}` | 網址格式錯誤 |
| 目標網址不在允許清單內（且非 localhost） | `403 Forbidden` | `{"error":"URL not in allowlist","url":"..."}` | 拒絕未授權網站 |

### 2.3 轉送端直接處理的 JSON-RPC 方法
Claude Code 連線時會送 `protocolVersion: "2025-11-25"`，並先打 `server/discover` 探測。

1. **`server/discover`**：
   - **請求**：`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}`
   - **回應（`200 OK`）**：
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "error": { "code": -32601, "message": "Method not found: server/discover" }
     }
     ```
2. **`initialize`**：
   - **回應（`200 OK`）**：回傳 `protocolVersion: "2025-11-25"`、`capabilities: { tools: { listChanged: true } }` 與 `serverInfo`。
3. **`notifications/initialized`**：
   - **回應**：`202 Accepted`（空內容）或 `200 OK` `{"ok":true}`。
4. **`ping`**：
   - **回應（`200 OK`）**：`{"jsonrpc":"2.0","id":2,"result":{}}`

### 2.4 轉送至分頁的方法（`tools/list`、`tools/call`）與多客戶端 ID 改寫
當多個 MCP 客戶端同時連同一個頁面時，各自的 JSON-RPC `id` 可能重複（例如都送 `"id": 1`）。
- **轉送端 ID 改寫機制**：
  1. `ai-proxy` 為每次呼叫產生唯一 `callId`（如 `"call_42"`）。
  2. 送給分頁 `/tab/v1/poll` 的 `rpc.id` 一律改寫為 `callId`。
  3. 分頁透過 `/tab/v1/reply` 回傳結果時，`ai-proxy` 將 `response.id` 換回該客戶端原本的 `id` 再回傳。
- **佇列上限與逾時錯誤**：
  - 單頁待處理佇列已滿（預設上限 `32` 筆）：回傳 JSON-RPC 錯誤 `{"code": -32000, "message": "Tab call queue full"}`。
  - 分頁未在時限內連上或執行逾時：回傳 JSON-RPC 錯誤 `{"code": -32001, "message": "Timed out waiting for browser tab"}`。

---

## 3. 瀏覽器分頁端點（`/tab/v1/*`）

除 `/tab/v1/probe` 外，所有 `/tab/v1/*` 請求皆須在標頭帶上該頁專屬金鑰：`Authorization: Bearer <mcp-key>`。

### 3.1 `POST /tab/v1/hello`
向轉送登記或重新建立分頁連線。
- **請求內容**：
  ```json
  {
    "url": "https://example.github.io/docs/mcp.html",
    "title": "Example Docs MCP",
    "tools": [
      {
        "name": "search_docs",
        "description": "搜尋文件",
        "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] },
        "annotations": { "readOnlyHint": true }
      }
    ]
  }
  ```
- **回應**：
  - `200 OK`：`{ "ok": true, "sessionId": "ses_9f8e7d6c5b4a", "normalizedUrl": "https://example.github.io/docs/mcp.html", "pollTimeoutMs": 25000 }`
  - `401 Unauthorized`：金鑰缺失或與該頁面網址不符。
  - `403 Forbidden`：頁面網址不在允許清單中，或 `Origin` 與頁面網址的 origin 不符。

### 3.2 `GET /tab/v1/poll?sessionId=<sessionId>`
長輪詢等待下一筆發往此分頁的 JSON-RPC 呼叫。
- **回應**：
  - `200 OK`：`{ "callId": "call_101", "rpc": { "jsonrpc": "2.0", "id": "call_101", "method": "tools/call", "params": { ... } } }`
  - `204 No Content`：長輪詢時間到且期間無新呼叫，分頁可繼續下一輪 `poll`。
  - `401 Unauthorized`：金鑰無效。
  - `409 Conflict`：`sessionId` 不存在或已失效（例如 `ai-proxy` 重啟過）；分頁收到 `409` 後**必須立刻重新呼叫 `POST /tab/v1/hello`**。

### 3.3 `POST /tab/v1/ack`
分頁收到呼叫後回報已開始處理，避免觸發連線等待逾時。
- **請求內容**：`{ "sessionId": "ses_9f8e7d6c5b4a", "callId": "call_101" }`
- **回應**：`200 OK` `{"ok": true}`、`404 Not Found`（無此 `callId`）或 `409 Conflict`（須重新 `hello`）。

### 3.4 `POST /tab/v1/reply`
分頁回傳工具執行完成的 JSON-RPC 結果或錯誤。
- **請求內容**：
  ```json
  {
    "sessionId": "ses_9f8e7d6c5b4a",
    "callId": "call_101",
    "response": {
      "jsonrpc": "2.0",
      "id": "call_101",
      "result": {
        "content": [{ "type": "text", "text": "{\"matches\":[]}" }],
        "isError": false
      }
    }
  }
  ```
- **回應**：`200 OK` `{"ok": true}`、`404 Not Found` 或 `409 Conflict`。

### 3.5 `POST /tab/v1/tools`
當分頁動態新增或移除工具時，即時同步工具目錄給轉送端。
- **請求內容**：`{ "sessionId": "ses_9f8e7d6c5b4a", "tools": [ ... ] }`
- **回應**：`200 OK` `{"ok": true}` 或 `409 Conflict`。

---

## 4. 給網頁使用的本機 Chat Completions（`/v1/*`）

提供給授權網頁（例如本站右上角「問 AI」側欄）呼叫本機模型（後端支援 `claude -p` 或任一 OpenAI 相容上游）。

### 4.1 Origin 檢查與唯讀工具限制
1. 帶 `Origin` 的請求必須符合：
   - 儀表板自身 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`），
   - 已透過 `ai-proxy allow-origin <origin>` 允許的 origin，或
   - 手動開啟的「允許任何 origin（`*`）」純聊天模式。
2. **工具過濾鐵律**：
   - `/v1` 僅開放**同時符合**以下兩項條件的工具給模型使用：
     1. 啟動時以 `--allow-tool mcp__<server>__<tool>` **一個一個點名**允許（禁止整個 server 一起開或萬用字元）；
     2. 工具本身的 `annotations.readOnlyHint === true`（唯讀工具）。
   - 當開啟「任何 origin 都能用 `/v1`（`*`）」時，強制為**純聊天模式（零工具）**，絕不提供任何工具。

### 4.2 `GET /v1/models` 與 `POST /v1/chat/completions`
- `GET /v1/models`：回傳可用模型清單。
- `POST /v1/chat/completions`：接受 `{ model, messages, stream: false }`，回傳標準 OpenAI `chat.completion` 格式；未授權 Origin 回傳 `403 Forbidden`。

---

## 5. 儀表板管理端點（`/admin/v1/*`）

除 `POST /admin/v1/open-dashboard` 外，所有 `/admin/v1/*` 路由皆須帶上管理金鑰：`Authorization: Bearer <admin-key>`。

### 5.1 `POST /admin/v1/open-dashboard`（唯一免金鑰管理路由）
當使用者在沒有管理金鑰的分頁點擊「接上（Connect）」按鈕時，請求 `ai-proxy` 自己打開帶金鑰的儀表板分頁。
- **安全限制**：
  1. 嚴格檢查 `Origin` 標頭，只接受登記過的儀表板自身 origin，否則回傳 `403 Forbidden`。
  2. 開啟的網址固定為登記過的儀表板網址（附帶 `#admin-key=<adminKey>&mcp-port=<port>`），不接受請求端傳入任意網址。
  3. **回應內容絕不回傳任何金鑰**（僅回傳 `{"ok": true, "opened": true}`）。
  4. 嚴格限速（Rate Limit），超過頻率回傳 `429 Too Many Requests`。

### 5.2 需管理金鑰的端點（`Authorization: Bearer <admin-key>`）

| 方法與路徑 | 請求內容 | 回應（`200 OK`） | 說明 |
| :--- | :--- | :--- | :--- |
| `GET /admin/v1/status` | — | `{ ok, port, sites, allowlist, allowedOrigins, openOriginMode, warnings }` | 取得完整狀態、已連線分頁與警告訊息 |
| `GET /admin/v1/sites` | — | `{ sites: [...] }` | 列出所有已註冊網站、連線狀態與工具清單 |
| `POST /admin/v1/sites` | `{ url, name?, openTab? }` | `{ ok: true, site: {...} }` | 新增網站（自動加入允許清單＋註冊進 Claude Code） |
| `DELETE /admin/v1/sites` | `{ url }` | `{ ok: true, removed: url }` | 刪除網站（從所有 AI 工具移除＋撤銷允許＋忘掉金鑰） |
| `POST /admin/v1/allow` | `{ prefix }` | `{ ok: true, allowlist: [...] }` | 新增允許清單網址前綴 |
| `POST /admin/v1/deny` | `{ prefix }` | `{ ok: true, allowlist: [...] }` | 移除允許清單前綴並中斷對應分頁連線 |
| `POST /admin/v1/origins` | `{ action: "allow"\|"deny", origin, ttlSeconds? }` | `{ ok: true, allowedOrigins, openOriginMode }` | 管理 `/v1` 的允許 origin 或啟閉限時 `*` 純聊天模式 |
| `POST /admin/v1/keys/rotate` | `{ url?: string, rotateAdmin?: boolean }` | `{ ok: true, rotated: [...] }` | 輪換指定頁面金鑰、全部頁面金鑰或管理金鑰 |
