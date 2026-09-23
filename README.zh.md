# livepad

[English](./README.md) | [中文](./README.zh.md)

livepad 是一个实时协作记事本和临时文件共享工具，使用 Server-Sent Events（SSE）同步，仅使用 Node.js 内置模块，保持零运行时依赖。

> livepad 面向可信本机或可信局域网，默认使用启动日志中的密码控制访问，也可显式指定免密码模式。它没有逐用户权限控制、内置 TLS 和静态数据加密，不应直接暴露到公网。

## 环境要求与安装

- Node.js 20 或更高版本；为了及时获得安全修复，请使用仍受官方支持的 Node.js 版本。
- npm 仅用于安装或运行此包。livepad 没有运行时依赖，也没有安装阶段脚本。

无需安装即可运行：

```bash
npx livepad
```

也可以全局安装 CLI：

```bash
npm install --global livepad
livepad
```

## CLI 使用方式

```text
livepad [port] [options]

-p, --port <port>        监听端口（默认：3000）
-H, --host <host>        监听地址（默认：0.0.0.0）
    --password <value>   指定密码（默认：每次启动随机生成）
    --no-password        免密码访问
    --clear              启动时清空之前的文本和文件
    --keep               保留文本和文件（默认行为，兼容旧用法）
-h, --help               显示帮助
-v, --version            显示版本
```

继续支持 `livepad 8080`，它等价于 `livepad --port 8080`。`PORT`、`HOST` 环境变量仅作为回退值，显式 CLI 参数优先。

```bash
livepad --password "my-password"  # 使用指定密码
livepad --no-password             # 显式免密码，也支持 --password=
livepad --clear                   # 清空旧文本和附件后启动
```

密码最多 128 个字符，不支持控制字符；含空格或 shell 特殊字符时请正确引用。`--password` 与 `--no-password` 不能同时使用，`--keep` 与 `--clear` 也不能同时使用。`node server.js` 与 `node cli.js` 支持相同参数。

默认监听所有 IPv4 网卡，用于可信局域网内共享：

```bash
livepad
# 其他设备打开启动日志中的 Network 地址即可访问。
```

如需仅允许本机访问：

```bash
livepad --host 127.0.0.1
```

启动时会按 `Local`、`Network` 列出当前监听范围内的访问 URL，包括适用的局域网和虚拟网卡地址，并在输出前检查各地址的本机连通性。默认会列出各 IPv4 网卡地址；`--host 127.0.0.1` 仅列出本机地址，`--host ::` 会列出可连接的 IPv6 和 IPv4 地址。不重复输出 `localhost` 别名，需要作用域标识的 IPv6 地址不作为浏览器链接输出。其他设备能否访问仍取决于路由和防火墙；容器中列出的是容器网卡地址和监听端口。

未指定密码参数时，每次启动都会生成新的 16 字符随机访问密码；`--password` 使用指定密码。密码会输出在 `Access password:` 日志行中，`Local`、`Network` 地址均带有经过 URL 编码的 `/?password=...` 参数，打开即可自动登录。页面会在发起登录前从地址栏移除密码参数；打开不带参数的地址时，仍可手动输入密码。livepad 不会将密码写入数据目录。持有完整链接的人可以登录，反向代理也可能在访问日志中记录初始 URL。所有已登录用户拥有相同权限，都能读取和修改共享文本，以及上传、下载或删除全部文件。

`--no-password` 或 `--password=` 将密码设置为空并关闭登录校验：页面直接进入工作区，接口无需 Cookie，启动日志会标明密码已禁用，链接不附加密码参数。此时任何能连接服务的设备都能读写数据。

启用密码时，登录使用 `HttpOnly`、`SameSite=Strict` 会话 Cookie。服务重启后会话始终更新，即使使用固定密码或 `--keep` 也不会保留登录状态；已打开的标签页需要重新登录，未同步的编辑仍保留在该标签页内存中。同一来源地址一分钟内登录失败 10 次后会暂时限制后续尝试，不影响已有会话。HTTP 不加密传输中的密码和内容，应使用可信网络，或通过 HTTPS 反向代理访问。

## 文件位置与清理策略

上传文件和共享文本以明文保存在系统临时目录下的 `.livepad`：

- Windows：`%TEMP%\.livepad`
- Linux/macOS：`${TMPDIR:-/tmp}/.livepad`

默认启动会恢复之前的共享文本和附件；`--keep` 作为兼容选项保留，效果与默认启动相同。只有显式传入 `--clear` 才会清空旧文本和附件。清理不会递归删除子目录、不会跟随符号链接，也不会用请求参数拼接删除路径。内部所有权标记用于识别被替换或无效的存储目录，不完整的内部阶段文件仍会在启动时清除。

共享文本保存在内部文件 `.livepad-text.json` 中，每次更新通过临时文件写入并替换，写盘成功后才广播并返回同步成功。写盘失败不会覆盖内存中的已保存文本，页面会保留未同步的草稿。该内部文件不会出现在附件列表中，也不能通过附件接口上传、下载或删除；“清空”附件不影响文本。存储文件损坏、超限或不是普通文件时，启动会报错并保留原内容。

操作系统也可能自行清理临时目录，所以默认保留不是备份机制；Docker 跨容器保留数据需要挂载数据卷。上传内容可能包含隐私数据，且所有已连接客户端都能读取。

## 资源限制

服务端会拒绝超过以下内置限制的请求：

| 资源 | 限制 |
|---|---:|
| 共享文本请求体 | 1 MiB |
| 整个 multipart 上传请求 | 25 MiB |
| 单文件 | 10 MiB |
| 单次 multipart 文件数 | 5 |
| UTF-8 文件名 | 255 字节 |
| 已保存文件数 | 100 |
| 已保存文件总大小 | 100 MiB |
| 并发上传 | 4 |
| SSE 客户端 | 32 |
| 每个 SSE 客户端缓冲 | 64 KiB |

multipart 请求最多在内存中保留 25 MiB；完整校验通过后才会在目标目录中创建阶段文件。boundary 缺失或异常、未知字段、重复文件名、不安全文件名、不支持的传输编码或非法 `Content-Type` 都会被拒绝。允许上传空文件。

服务还设置了请求头/请求体超时、请求头数量上限、keep-alive 复用上限和全局连接上限。这些限制可以减轻误操作和简单的资源耗尽攻击，但不能替代逐用户配额、反向代理或网络层限流。

## Web 界面

在一个或多个标签页打开 CLI 输出的地址即可自动登录；使用不带密码参数的地址时，可手动输入启动日志中的密码。编辑器会同步浏览器输入；附件区域支持选择上传、拖放上传、下载、单个删除和全部清空。文件名通过 DOM 文本节点渲染，不会拼接为 HTML。

## HTTP 与 SSE 协议

| 方法 | 路径 | 用途 | 成功状态码 |
|---|---|---|---:|
| `GET` | `/` | 登录及工作区外壳，不包含共享数据 | `200` |
| `POST` | `/auth/login` | JSON `{ "password": "..." }`；设置会话 Cookie | `204` |
| `GET` | `/auth/session` | 检查会话 Cookie | `204` |
| `GET` | `/events` | SSE 数据流 | `200` |
| `POST` | `/update` | JSON `{ "content": "..." }` | `204` |
| `GET` | `/files` | JSON 文件列表 | `200` |
| `POST` | `/upload` | `multipart/form-data`；重复 `file` 或 `files` 可上传多个文件 | `201` |
| `GET` | `/file/:name` | 下载文件 | `200` |
| `DELETE` | `/file/:name` | 删除单个文件 | `204` |
| `DELETE` | `/files` | 删除全部普通存储文件 | `204` |

启用密码时，除 HTML 外壳和登录接口外，所有接口都要求有效会话 Cookie，包括 SSE 和直接下载链接；未登录返回 `401`。打开 `/?password=...` 时，页面会自动将密码提交到 `/auth/login`。API 客户端需要保存并携带 `/auth/login` 返回的 Cookie，数据接口不接受 URL 查询参数中的密码。密码错误返回 `401`，触发登录限流时返回 `429` 和 `Retry-After`。免密码模式下无需 Cookie，写请求的同源检查和资源限制仍然生效。

SSE 事件包括 `init`、`text`、`files` 和 `heartbeat`。带有 `Origin` 请求头的浏览器写请求必须同源，登录接口也不例外。错误响应为 `{ "error": { "code": "...", "message": "..." } }` 格式的 JSON。

新上传文件的文件名会进行 Unicode NFC 规范化。通过 `--keep` 保留的旧文件在文件列表、下载和删除 URL 中使用磁盘上的原始名称，启动时不会合并或覆盖不同的旧文件名。绝对路径、路径分隔符、控制字符、编码后的穿越路径、Windows 设备名、内部名称（包括大小写变体）和跨平台不安全字符会被直接拒绝，不会静默改名。

## Docker

容器内会显式绑定 `0.0.0.0`，确保 Docker 端口映射可用：

```bash
docker run --rm -p 3000:3000 zqzyz/livepad
docker run --rm -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad
```

访问密码会输出在容器日志中，可通过 `docker compose logs livepad` 查看。映射容器端口不会自动增加 TLS。构建和 compose 示例见 [docs/docker.md](./docs/docker.md)。

## 开发与验证

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
```

项目不需要转译；`build` 负责校验发布 JavaScript 的语法有效性。测试使用 Node.js 内置 test runner。

## Issue 与安全问题反馈

- 功能缺陷：[GitHub Issues](https://github.com/cnxzq/livepad/issues)
- 安全漏洞：请提交[私有 GitHub Security Advisory](https://github.com/cnxzq/livepad/security/advisories/new)，不要在公开 Issue 中粘贴凭据、私有文件或完整利用细节。

安全报告请包含受影响版本、操作系统、Node.js 版本、复现步骤和影响；示例中应删除真实密钥和个人数据。

## License

[MIT](./LICENSE)
