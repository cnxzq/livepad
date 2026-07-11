# livepad

[English](./README.md) | [中文](./README.zh.md)

Real-time collaborative notepad + file sharing — zero dependencies, Node.js built-ins only.

- 📝 Full-screen textarea, synced across all clients in real-time
- 📎 File attachments — upload, download, delete, synced for everyone
- 🔒 Auto-clears temp files on startup (privacy-first)

## Usage

```bash
npx livepad              # default port 3000, clears previous files
npx livepad 8080         # custom port
npx livepad --keep       # preserve files from last session
```

Open `http://localhost:3000` in multiple tabs or devices — start typing or drop files.

### Docker

```bash
# Quick start
docker run -p 3000:3000 zqzyz/livepad

# Custom port
docker run -p 8080:8080 -e PORT=8080 zqzyz/livepad

# Persist uploaded files
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad

# Keep files from last session (no auto-clear)
docker run -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad --keep
```

Or use docker compose:

```bash
docker compose up -d
```

## What Problems It Solves

- **No setup** — no install, no account. One `npx livepad` and you're live
- **Data stays local** — zero cloud dependency, your data never leaves your machine
- **Zero dependencies** — no supply-chain risk, easy to audit (one small JS file)
- **Cross-device clipboard** — type on PC, see it on phone instantly (same LAN)
- **Quick file transfer** — send files between devices without USB or email

## When to Use

- Sharing text/code snippets between your own devices
- Temporary collaborative note-taking during a meeting
- Quick file transfer between computers on the same LAN
- Pastebin-style sharing without a third-party service
- Pair programming scratchpad for sharing ideas
- Offline/LAN environments where internet access is restricted

## When NOT to Use

- **Production document collaboration** — use Google Docs, Notion, or similar
- **Long-term persistent notes** — auto-clears on restart by default (use `--keep` with caution)
- **Large file transfer (>100MB)** — no chunked upload or resume support
- **Authenticated multi-user setups** — no auth or user management built in
- **Edit history/versioning** — only browser-level undo is available
- **Sensitive encrypted data** — no encryption at rest
- **Internet-accessible sharing** — no HTTPS or tunneling built in

## Features

| Feature | How |
|---------|-----|
| Realtime editing | Type in the left textarea; syncs after 500ms idle |
| Upload files | Click "Upload" or drag & drop anywhere |
| Download files | Click filename in the attachment panel |
| Delete files | Click ✕ next to the file |
| Clear all | Click "Clear" button |

All clients see the same attachment list in real-time via SSE.

## How It Works

- **SSE** — server pushes text and file list updates
- **HTTP POST + multipart** — hand-written multipart parser, zero deps
- Files stored in system temp dir `.livepad/` (cleared on restart by default)
