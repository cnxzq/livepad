# livepad

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
