# livepad

livepad 的兼容安装入口，实际功能由 `@livepad/cli` 提供。需要 Node.js 20 或更高版本。

```bash
npx livepad@latest
# 或全局安装
npm install -g livepad
livepad --help
```

保留原有 `livepad` 命令、参数及 `require('livepad')` 服务端 API。也可直接安装 `@livepad/cli`，两者提供相同命令，选择其中一个安装即可。

默认访问密码输出在启动日志中。面向可信本机或局域网，没有内置 TLS，不应直接暴露到公网。

[中文使用说明](https://github.com/cnxzq/livepad/blob/main/README.zh.md) · [English documentation](https://github.com/cnxzq/livepad#readme) · [Docker](https://github.com/cnxzq/livepad/blob/main/docs/docker.md)
