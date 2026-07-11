# Docker

## 构建

```bash
# 构建（同时打 version 和 latest 标签）
docker build -t zqzyz/livepad:v2.3.1 -t zqzyz/livepad:latest .
```

## 推送

```bash
# 登录 Docker Hub
docker login

# 推送所有标签
docker push zqzyz/livepad:v2.3.1
docker push zqzyz/livepad:latest
```

## 运行

```bash
# 默认启动
docker run -p 3000:3000 zqzyz/livepad

# 自定义端口
docker run -p 8080:8080 -e PORT=8080 zqzyz/livepad

# 保留上次会话的文件（不清除）
docker run -p 3000:3000 zqzyz/livepad --keep

# 持久化上传的文件
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad

# 持久化 + 保留文件
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad --keep
```

## Docker Compose

```bash
# 启动
docker compose up -d

# 停止
docker compose down

# 停止并删除数据卷
docker compose down -v
```
