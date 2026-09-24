# Docker

## 构建

在仓库根目录中执行。镜像仓库为 `zqzyz/livepad`，版本号自动读取 `packages/cli/package.json`，同时生成 `v<版本号>` 和 `latest` 标签，无需手动修改命令。Dockerfile 直接复制 `packages/cli` 的实现和静态页面，不依赖 npm 上是否已发布新包。

```bash
# 只构建
pnpm docker:build

# 预览构建命令，不执行 Docker
pnpm docker:build --dry-run
```

## 推送

```bash
# 登录 Docker Hub
docker login

# 一条命令构建并推送版本标签和 latest
pnpm publish:docker

# 只推送已有的本地版本标签和 latest
pnpm docker:push

# 预览完整发布流程，不构建、不上传
pnpm publish:docker --dry-run
```

构建或任一标签推送失败时立即停止；只推送时请确保本地两个标签均来自要发布的版本。以上脚本支持 Windows、macOS 和 Linux，需要已安装并启动 Docker，推送时需要账号拥有 `zqzyz/livepad` 的写入权限。

## 运行

镜像和 npm CLI 均默认监听 `0.0.0.0`，容器可通过 Docker 端口映射访问。直接运行 CLI 时，如需仅允许本机访问，可使用 `--host 127.0.0.1`。

```bash
# 默认启动
docker run -p 3000:3000 zqzyz/livepad

# 自定义端口
docker run -p 8080:8080 -e PORT=8080 zqzyz/livepad

# 自定义密码
docker run -p 3000:3000 zqzyz/livepad --password "my-password"

# 持久化文本和附件，默认在下次启动时恢复
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad

# 免密码访问
docker run -p 3000:3000 zqzyz/livepad --no-password

# 显式清空数据卷内的旧文本和附件后启动
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad --clear
```

启动后通过 `docker logs <容器名>` 或 `docker compose logs livepad` 查看 `Access password:`，可手动输入密码，或在宿主机访问地址后加 `/?password=经过URL编码的密码` 自动登录。日志中的链接已带密码参数；访问容器时需按端口映射调整为宿主机地址和端口。未指定密码时每次重启都会生成新密码；`--password` 使用指定值，`--no-password` 关闭登录校验。默认保留文本和附件，`--keep` 是兼容选项；启用密码时，登录会话始终在重启后失效。

数据仍位于 `/tmp/.livepad`；替换容器时要保留数据，必须挂载数据卷。仓库中的 Compose 配置已经挂载 `livepad-data`，可通过 `command: ["--password", "my-password"]` 设置固定密码。

> livepad 默认使用共享密码控制访问，没有内置 TLS 或逐用户权限控制。免密码模式允许所有可连接设备读写数据。即使通过 Docker 运行，也只应暴露给可信网络；不要直接映射到公网接口。

## Docker Compose

```bash
# 启动
docker compose up -d

# 停止
docker compose down

# 停止并删除数据卷
docker compose down -v
```
