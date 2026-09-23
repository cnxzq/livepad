# Docker

## 构建

```bash
# 构建（同时打 version 和 latest 标签）
docker build -t zqzyz/livepad:v2.4.0 -t zqzyz/livepad:latest .
```

## 推送

```bash
# 登录 Docker Hub
docker login

# 推送所有标签
docker push zqzyz/livepad:v2.4.0
docker push zqzyz/livepad:latest
```

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
