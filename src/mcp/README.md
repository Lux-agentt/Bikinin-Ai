# MCP di Bikinin AI (Fase 6, Track D)

MCP (Model Context Protocol) membiarkan agent memanggil tool dari server
eksternal lewat JSON-RPC 2.0 over stdio. Client minimal ada di `client.ts`;
tool agent-nya adalah `mcp_call` (`src/tools/mcp-call.ts`).

## Cara kerja

1. Pemilik mendaftarkan server di env `BIKININ_MCP_SERVERS` (JSON array).
   Contoh (tanpa secret — lihat catatan keamanan di bawah):

   ```json
   [
     {
       "name": "echo",
       "command": "npx",
       "args": ["tsx", "scripts/mcp-echo-server.ts"]
     }
   ]
   ```

2. Tool `mcp_call` menerima `{ server, tool, arguments }`, lalu:
   - mencari server berdasarkan `name`,
   - spawn proses server (tanpa shell),
   - handshake `initialize` + `notifications/initialized`,
   - `tools/list` untuk memastikan tool itu ada,
   - `tools/call`, lalu mematikan proses server.
3. Timeout per request: 15 detik. Output dipotong ke 8.000 karakter.

## Server contoh (offline, tanpa network)

`scripts/mcp-echo-server.ts` adalah server MCP minimal tanpa dependensi
baru. Satu tool: `echo` (mengembalikan `text` yang dikirim). Smoke test:

```sh
npx tsx scripts/smoke-mcp.ts
```

## Menambah server lain

### Filesystem server resmi (baca/tulis file di satu folder)

```json
[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/ke/folder"]
  }
]
```

Batasi ke folder yang memang boleh disentuh agent. Server ini bisa menulis
file — hanya daftarkan bila pemilik percaya penuh pada folder itu.

### GitHub server resmi (baca repo, issue, PR)

```json
[
  {
    "name": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"]
  }
]
```

Server ini butuh token GitHub. **Jangan tulis token di JSON config.**
Karena client mewarisi env proses induk, set token lewat Codespaces secret
/ env shell sebelum menjalankan server, mis. `GITHUB_PERSONAL_ACCESS_TOKEN`
(nama var persisnya mengikuti dokumentasi server itu).

### Server lain

Pola yang sama: `{ "name", "command", "args?", "env?" }`. Field `env` di
config hanya untuk nilai non-rahasia. Perintah dijalankan langsung tanpa
shell (`spawn`), jadi tidak ada `sh -c` / pipe / substitusi perintah.

## Keamanan

- `mcp_call` bertanda `readOnly: false` dengan sengaja: tool MCP bisa apa
  saja (baca, tulis, jaringan). Keamanan datang dari **server yang dipilih
  pemilik**, bukan dari tool ini. Jangan daftarkan server yang tidak
  dipercaya.
- Jangan pernah menaruh key/token/password di `BIKININ_MCP_SERVERS` atau di
  file repo apa pun. Token lewat env proses (Codespaces secrets).
- Client memvalidasi nama tool (`[A-Za-z0-9_.-]`) dan argumen harus JSON
  biasa sebelum dikirim.

## Integrasi (selesai oleh integrator Fase 6)

- `"git"`, `"mcp_call"`, `"inspect_image"`, dan `"request_plan_approval"`
  ada di enum `ToolName` (`src/events.ts`); cast `as unknown as ToolName`
  sudah dihapus dari `src/tools/git.ts` dan `src/tools/mcp-call.ts`.
- `gitTool`, `mcpCallTool`, `inspectImageTool`, dan
  `requestPlanApprovalTool` terdaftar di `src/tools/registry.ts`.
- Batasan yang masih ada: client hanya stdio (bukan HTTP/SSE transport);
  tidak ada reconnect otomatis; satu panggilan `mcp_call` = satu proses
  server yang di-spawn lalu dimatikan.
