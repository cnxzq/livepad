# livepad

[English](./README.md) | [中文](./README.zh.md)

livepad is a real-time collaborative notepad and temporary file-sharing tool. It uses Server-Sent Events (SSE) and Node.js built-in modules only, with zero runtime dependencies.

> livepad is designed for trusted local machines and trusted LANs. Access uses the password printed at startup by default; password-free access must be explicitly enabled. It has no per-user permissions, built-in TLS, or encryption at rest. Do not expose it directly to the public internet.

## Requirements and installation

- Node.js 20 or newer; use a currently supported Node.js release for security fixes.
- npm is only needed to install or run the package. livepad has no runtime dependencies and no install-stage scripts.

Run without installing:

```bash
npx livepad
```

Or install the CLI globally:

```bash
npm install --global livepad
livepad
```

## CLI usage

```text
livepad [port] [options]

-p, --port <port>        Listening port (default: 3000)
-H, --host <host>        Listening host (default: 0.0.0.0)
    --password <value>   Use a fixed password (default: random per startup)
    --no-password        Allow access without a password
    --clear              Clear stored text and files on startup
    --keep               Preserve text and files (default; compatibility option)
-h, --help               Show help
-v, --version            Show the version
```

`livepad 8080` remains supported as the short form of `livepad --port 8080`. `PORT` and `HOST` environment variables are fallbacks; explicit CLI values take precedence.

```bash
livepad --password "my-password"  # Use a fixed password
livepad --no-password             # Explicitly disable login; --password= also works
livepad --clear                   # Clear previous text and attachments before starting
```

Passwords support up to 128 characters without control characters; quote shell-special characters and spaces appropriately. `--password` and `--no-password` are mutually exclusive, as are `--keep` and `--clear`. `node server.js` and `node cli.js` accept the same options.

The default listens on all IPv4 interfaces for sharing on a trusted LAN:

```bash
livepad
# Open a printed Network URL on another device.
```

To restrict access to this machine:

```bash
livepad --host 127.0.0.1
```

Startup lists `Local` and `Network` URLs for the listening address, including applicable LAN and virtual-adapter addresses. It checks local connectivity to each address before printing it. The default includes IPv4 interface addresses; `--host 127.0.0.1` lists only the local address, and `--host ::` includes reachable IPv6 and IPv4 addresses. The `localhost` alias is not repeated. Scoped IPv6 addresses are omitted from browser links. Access from another device still depends on routing and firewall rules; container URLs reflect the container's interfaces and listening port.

Without a password option, each startup generates a new 16-character random access password; `--password` uses the supplied value instead. The password is printed on an `Access password:` line. Listed `Local` and `Network` URLs include a URL-encoded `/?password=...` for automatic sign-in. The page removes the password parameter from the address bar before signing in; opening a URL without it allows manual password entry. livepad does not write the password to its data directory. Anyone with the full link can sign in, and proxies may record the initial URL in access logs. All signed-in users share the same permissions to read and change text and upload, download, or delete files.

`--no-password` or `--password=` sets an empty password and disables authentication: the page opens the workspace directly, APIs need no cookie, and startup logs indicate that the password is disabled and omit the query parameter. Any device that can connect can read and modify the data in this mode.

With authentication enabled, login uses an `HttpOnly`, `SameSite=Strict` session cookie. Restarting the server always rotates the session, even with a fixed password or `--keep`; open tabs must sign in again and retain unsynced edits in memory. Ten failed login attempts from the same source address within one minute temporarily block further attempts. Existing sessions remain usable. HTTP does not encrypt the password or content in transit; use a trusted network, or put HTTPS in front of the service.

## File storage and cleanup

Uploads and shared text are stored as plaintext in `.livepad` under the operating system temporary directory:

- Windows: `%TEMP%\.livepad`
- Linux/macOS: `${TMPDIR:-/tmp}/.livepad`

Startup restores previous text and attachments by default. `--keep` remains a compatibility option with the same behavior. Only an explicit `--clear` clears old text and attachments. Cleanup does not recursively remove nested directories, follow symbolic links, or build deletion paths from request input. An internal ownership marker is used to detect an invalid or replaced storage directory. Incomplete internal staging files are still removed on startup.

Shared text is stored in the internal `.livepad-text.json` file. Each update writes a temporary file and replaces the saved version before broadcasting and acknowledging success. A failed save preserves the previously saved text in memory, and the page retains the unsynced draft. This internal file is hidden from attachments and cannot be uploaded, downloaded, or deleted through attachment routes; clearing attachments leaves text intact. Corrupt, oversized, or non-regular text storage causes startup to fail while preserving the original data.

The operating system may also clear its temporary directory independently. Default retention is not a backup mechanism; Docker requires a data volume to retain data across container replacement. Uploaded files may contain private data and are readable by every connected client.

## Resource limits

The server rejects requests that exceed these built-in limits:

| Resource | Limit |
|---|---:|
| Shared-text request body | 1 MiB |
| Entire multipart upload request | 25 MiB |
| One file | 10 MiB |
| Files in one multipart request | 5 |
| UTF-8 file name | 255 bytes |
| Stored files | 100 |
| Total stored file data | 100 MiB |
| Concurrent uploads | 4 |
| SSE clients | 32 |
| Buffered data per SSE client | 64 KiB |

The multipart request is held in memory only up to its 25 MiB cap, then validated completely before any file is staged. Uploads with a missing or malformed boundary, unknown field, duplicate file name, unsafe file name, unsupported transfer encoding, or invalid `Content-Type` are rejected. Empty files are supported.

Requests have header/body timeouts, bounded header counts, bounded keep-alive reuse, and a global connection limit. These controls reduce accidental or simple resource exhaustion; they are not a replacement for per-user quotas, a reverse proxy, or network-level rate limiting.

## Web UI

Open a displayed URL in one or more tabs to sign in automatically, or enter the startup password manually when using a URL without the password parameter. The editor synchronizes after browser input, and the attachment panel supports upload, drag-and-drop, download, individual deletion, and clearing all files. File names are rendered with DOM text nodes rather than HTML.

## HTTP and SSE protocol

| Method | Path | Purpose | Success |
|---|---|---|---:|
| `GET` | `/` | Login/workspace shell; contains no shared data | `200` |
| `POST` | `/auth/login` | JSON `{ "password": "..." }`; sets the session cookie | `204` |
| `GET` | `/auth/session` | Check the session cookie | `204` |
| `GET` | `/events` | SSE stream | `200` |
| `POST` | `/update` | JSON `{ "content": "..." }` | `204` |
| `GET` | `/files` | JSON file list | `200` |
| `POST` | `/upload` | `multipart/form-data`; repeat `file` or `files` for multiple files | `201` |
| `GET` | `/file/:name` | Download one file | `200` |
| `DELETE` | `/file/:name` | Delete one file | `204` |
| `DELETE` | `/files` | Delete all regular stored files | `204` |

With authentication enabled, every route except the HTML shell and login endpoint requires the session cookie and returns `401` without it, including SSE and direct file downloads. Opening `/?password=...` lets the page submit the password to `/auth/login` automatically. API clients must retain the cookie returned by `/auth/login`; data endpoints do not accept passwords in query strings. Invalid passwords return `401`; login throttling returns `429` with `Retry-After`. Password-free mode requires no cookie but retains origin checks on writes and resource limits.

SSE uses `init`, `text`, `files`, and `heartbeat` events. State-changing browser requests with an `Origin` header must be same-origin, including login. Error responses use JSON in the form `{ "error": { "code": "...", "message": "..." } }`.

New upload file names are Unicode NFC-normalized. Existing files kept with `--keep` retain their exact stored names in file lists, download URLs, and deletion URLs, so distinct legacy names are not merged or overwritten during startup. Absolute paths, path separators, control characters, encoded traversal forms, Windows device names, internal names (including case variants), and platform-unsafe characters are rejected rather than silently rewritten.

## Docker

The container explicitly binds `0.0.0.0` so that the published Docker port works:

```bash
docker run --rm -p 3000:3000 zqzyz/livepad
docker run --rm -p 3000:3000 -v livepad-data:/tmp/.livepad zqzyz/livepad
```

The access password is printed in the container logs (`docker compose logs livepad`). Binding a container port does not add TLS. See [docs/docker.md](./docs/docker.md) for build and compose examples.

## Development and verification

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
```

There is no transpilation step; `build` performs a syntax-validity gate on the published JavaScript. Tests use Node.js's built-in test runner.

## Security and issue reporting

- Functional bugs: [GitHub Issues](https://github.com/cnxzq/livepad/issues)
- Security vulnerabilities: use a [private GitHub security advisory](https://github.com/cnxzq/livepad/security/advisories/new). Do not put credentials, private files, or exploit details in a public issue.

When reporting a security issue, include the affected version, operating system, Node.js version, reproduction steps, and impact. Remove real secrets and personal data from samples.

## License

[MIT](./LICENSE)
