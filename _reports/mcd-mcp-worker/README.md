# 麦当劳 MCP Worker 部署

5 分钟搞定。

## 1. 装 wrangler (一次)

```bash
npm install -g wrangler
```

## 2. 登录 CF

```bash
wrangler login
```

弹浏览器, 选你的 CF 账号授权。

## 3. 部署

在 `mcd-mcp-worker` 目录下:

```bash
wrangler deploy
```

看到 `Published mcd-mcp-proxy` 那一行 + 一个 `*.workers.dev` URL, 复制下来, 就是你的 worker 地址, 长这样:

```
https://mcd-mcp-proxy.<你的subdomain>.workers.dev
```

## 4. 验证 worker 能跑

```bash
curl -i -X POST "https://mcd-mcp-proxy.<你的subdomain>.workers.dev/?target=https%3A%2F%2Fmcp.mcd.cn%2F" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer 2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.0.1"}}}'
```

应该看到 200 + `serverInfo.name = mcd-mcp`。

## 5. 在 330 MCP 设置里填 3 个字段

| 字段 | 值 |
|---|---|
| server.url | `https://mcp.mcd.cn/` |
| bearerToken | `2GoJbi6KxA6ujtTnXOwjd6q8aSF4o5mv` (或 revoke 后新申请的) |
| proxyUrl | `https://mcd-mcp-proxy.<你的subdomain>.workers.dev` |

330 mcp-generic-client.js 会自动:
- 把请求改成 `POST <proxyUrl>?target=<url-encoded server.url>`
- 透传 Authorization / Accept / User-Agent 等所有头
- worker 透传到 mcd.cn, mcd.cn 看到完整 header 返 200 + 数据

## 可选: 加 PROXY_KEY 防白嫖

1. Cloudflare Dashboard → Workers → `mcd-mcp-proxy` → Settings → Variables → 加 `PROXY_KEY = <一长串随机字符>`
2. wrangler.toml 里把 `[vars]` 那段 PROXY_KEY 行启用 (改 wrangler deploy)
3. 330 这边目前 mcp-generic-client.js 不支持自定义 header, 跳过这步, 直接用 worker URL 就够了 (免费版每天 10 万次, 自己 + 朋友小圈子根本用不完)

## 关键设计: 为什么 worker.js 透传**所有** header

`mcd.cn` 看到非标准 MCP 客户端 (缺 User-Agent / Accept-Encoding / Accept-Language) 会软拒绝:
- 返 `202 Accepted` + `Content-Length: 0` + 0 帧 SSE
- 5 秒后超时, 看起来像"没菜单"

通用 worker 模板只透传 5 个精选 header (Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version), 就会触发这个软拒。
我这个版本透传所有 (除了 host/connection/upgrade 等 fetch 语义破坏的), mcd.cn 看到完整浏览器 header 就返 200 + serverInfo + 真实数据。

Node fetch 直连测试 (绕过 worker) 同样 200, 证明问题在 header 透传, 不在 mcd.cn 本身。
