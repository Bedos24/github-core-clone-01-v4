# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge in TypeScript for Node 22, zero dependencies, no git binary,
no network beyond the trial's env: it serves git smart HTTP (upload-pack
protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint
from one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

## Lifecycle (main.ts)

1. Bind an ephemeral port (`server.listen(0)`). Never 8080: the env owns it.
2. `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. Poll `GET $MAKEFUN_ENV_URL/done` until it answers `{"done": true}`.
4. Close the server and exit 0.

## Layout

- `main.ts` — the lifecycle above.
- `app.ts` — the HTTP server: routing, bearer auth, body reading, git
  smart-HTTP wiring, and the minimal REST v3 surface (repositories, contents,
  issues).
- `store.ts` — the in-memory store, the git object model, pack read/write
  (including OFS/REF delta decode), and pkt-line framing.
- `gitproto.ts` — the git wire: protocol v2/v0 upload-pack (ls-refs, fetch
  with shallow/deepen), v0 receive-pack with per-ref report-status, and the
  fetch planner (what a fetch sends, which commits stay shallow).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Status

Part 1 of the build: the core (lifecycle, HTTP server, store, git protocol)
plus the minimal REST the git conformance checks need. The full REST v3
resources, GraphQL v4 and the MCP endpoint land in part 2.

## Notes on the protocol

- The bearer token in `MAKEFUN_SHOP_TOKEN` names the viewer; a repository
  belongs to that login, so the same name under another owner is a 404.
- Every REST reply is `application/json` and carries a non-empty
  `X-GitHub-Request-Id`; errors carry a JSON body with a string `message`.
- Pushes must fast-forward: a non-fast-forward ref is refused per ref with
  `ng <ref> non-fast-forward`, and the ref does not move.
- Packs the forge sends are plain (undeltified) objects; packs it receives
  may carry OFS or REF deltas, resolved against the pack or the store.
