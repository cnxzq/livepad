# @livepad/cli

livepad 的 CLI、HTTP/SSE 服务端和网页实现，仅使用 Node.js 内置模块。需要 Node.js 20 或更高版本。

```bash
pnpm dlx @livepad/cli
# 或全局安装
pnpm add -g @livepad/cli
livepad --help
```

两个安装入口 `@livepad/cli` 和 `livepad` 提供相同的 `livepad` 命令，选择其中一个安装即可。`livepad` 兼容包依赖本包，不包含另一份实现。

默认访问密码输出在启动日志中。面向可信本机或局域网，没有内置 TLS，不应直接暴露到公网。

服务端 API 可通过 `require('@livepad/cli')` 使用，CLI API 可通过 `require('@livepad/cli/cli')` 使用。

[中文使用说明](https://github.com/cnxzq/livepad/blob/main/README.zh.md) · [English documentation](https://github.com/cnxzq/livepad#readme) · [Docker](https://github.com/cnxzq/livepad/blob/main/docs/docker.md)
