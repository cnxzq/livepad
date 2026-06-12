# livepad

实时协作便签 — 零依赖，仅用 Node.js 内置模块（`http` + `fs` + `path`）。

所有客户端共享同一个 textarea，任意修改即时同步。

## 使用

```bash
npx livepad        # 默认 3000 端口
npx livepad 8080   # 指定端口
```

打开浏览器访问 `http://localhost:3000`，多个标签页/设备访问同一地址即可实时协作。

## 原理

- **SSE (Server-Sent Events)** — 服务端主动推送更新到所有客户端
- **HTTP POST** — 客户端提交修改到服务端
- 服务端内存中保存唯一一份共享内容，零数据库、零外部依赖
- 正在输入的客户端不回显自己的更新，避免光标跳动

## 技术栈

0 个第三方依赖。仅使用 Node.js 内置：

- `http` — HTTP 服务
- `fs` — 读取静态文件
- HTML5 `EventSource` — 客户端接收实时推送
- `fetch` — 客户端提交更新
