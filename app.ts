// app.ts — the HTTP server: routing, bearer auth, body reading, git smart-HTTP
// wiring, and the minimal REST v3 surface part 1 needs (repos, contents, issues).
// REST v3 resources, GraphQL v4 and MCP land in part 2; this file is their shell.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  commitContents,
  handleReceivePack,
  handleUploadPack,
  infoRefs,
  readContentsPath,
} from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  branchTip,
  createCommentRecord,
  createIssueRecord,
  createPullRecord,
  deletePathCommit,
  issueJson,
  listCommits,
  listIssues,
  pullFiles,
  pullJson,
  repoJson,
  squashMerge,
} from './rest.ts';
import { Store, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(store: Store = new Store()): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const requestId = (): string => {
    requestCounter += 1;
    return `req-${requestCounter}`;
  };

  /** Bearer auth: the env's token, or any non-empty bearer when the env sets none. */
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    if (expectedToken === '') return match[1].length > 0;
    return match[1] === expectedToken;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId() });
        return;
      }
      const path = url.pathname;
      const segments = path.split('/').filter((segment) => segment.length > 0);

      // The env's boot probe takes no token.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const rid = requestId();
      const extra = { 'x-github-request-id': rid };

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -4);
        const rest = segments.slice(2);
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, extra);
          return;
        }
        store.learnOwner(owner, repoName);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, extra);
          return;
        }
        if (store.viewerLogin !== null && owner !== store.viewerLogin) {
          sendJson(res, 404, { message: 'Not Found' }, extra);
          return;
        }
        if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'Bad Request' }, extra);
            return;
          }
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const result = infoRefs(repo, service, wantsV2);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && rest.length === 1 && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
          const body = await readBody(req);
          if (rest[0] === 'git-upload-pack') {
            const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = handleUploadPack(repo, body, wantsV2);
            if (result.contentType.startsWith('application/json')) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), extra);
            } else {
              sendRaw(res, result.status, result.contentType, result.body);
            }
            return;
          }
          const result = handleReceivePack(repo, body);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, extra);
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, extra);
          return;
        }
        const rest = segments.slice(2);

        // API root.
        if (method === 'GET' && rest.length === 0) {
          sendJson(
            res,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { ...extra, 'x-oauth-scopes': 'repo, read:org' },
          );
          return;
        }

        // Meta.
        if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
          sendJson(res, 200, { installed_version: '1.0.0' }, extra);
          return;
        }

        // The token's user (the login is learned from owner-named requests).
        if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
          if (store.viewerLogin === null) {
            sendJson(res, 404, { message: 'Not Found' }, extra);
            return;
          }
          sendJson(
            res,
            200,
            { login: store.viewerLogin, id: 1, type: 'User', html_url: `https://example.invalid/${store.viewerLogin}` },
            extra,
          );
          return;
        }

        // Create a repository for the token's user.
        if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
            return;
          }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          const name = typeof body.name === 'string' ? body.name : '';
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
            sendJson(res, 422, { message: 'Validation Failed: name is invalid' }, extra);
            return;
          }
          if (store.repos.has(name)) {
            sendJson(res, 422, { message: 'Validation Failed: name already exists on this account' }, extra);
            return;
          }
          const repo = store.createRepo(
            name,
            typeof body.description === 'string' ? body.description : '',
            body.private === true,
          );
          sendJson(res, 201, repoJson(repo), extra);
          return;
        }

        // The token user's repositories, paginated.
        if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
          const owner = store.viewerLogin ?? '';
          const all = store.listRepos(owner);
          const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
          const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
          const slice = all.slice((page - 1) * perPage, page * perPage);
          const headers: Record<string, string> = { ...extra };
          const totalPages = Math.max(1, Math.ceil(all.length / perPage));
          if (page < totalPages) {
            const host = req.headers.host ?? 'entry';
            const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
            const links = [`<${base}&page=${page + 1}>; rel="next"`, `<${base}&page=${totalPages}>; rel="last"`];
            if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`, `<${base}&page=1>; rel="first"`);
            headers.link = links.join(', ');
          }
          sendJson(res, 200, slice.map((repo) => repoJson(repo)), headers);
          return;
        }

        // Repository-scoped routes: /repos/{owner}/{repo}/...
        if (rest.length >= 3 && rest[0] === 'repos') {
          const owner = rest[1];
          const repoName = rest[2];
          store.learnOwner(owner, repoName);
          const repo = store.getRepo(owner, repoName);
          if (!repo || (store.viewerLogin !== null && owner !== store.viewerLogin)) {
            sendJson(res, 404, { message: 'Not Found' }, extra);
            return;
          }
          const tail = rest.slice(3);

          // GET the repository.
          if (method === 'GET' && tail.length === 0) {
            sendJson(res, 200, repoJson(repo), extra);
            return;
          }

          // PATCH the repository (description, visibility).
          if (method === 'PATCH' && tail.length === 0) {
            const raw = await readBody(req);
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
              return;
            }
            const body = (parsed.value ?? {}) as Record<string, unknown>;
            if (typeof body.description === 'string') repo.description = body.description;
            if (typeof body.private === 'boolean') repo.isPrivate = body.private;
            repo.updatedAt = new Date().toISOString();
            sendJson(res, 200, repoJson(repo), extra);
            return;
          }

          // DELETE the repository.
          if (method === 'DELETE' && tail.length === 0) {
            store.repos.delete(repoName);
            res.writeHead(204, { ...extra });
            res.end();
            return;
          }

          // Branches: list, and one branch.
          if (tail.length >= 1 && tail[0] === 'branches') {
            if (method === 'GET' && tail.length === 1) {
              const branches = [...repo.refs.entries()]
                .filter(([ref]) => ref.startsWith('refs/heads/'))
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
              sendJson(res, 200, branches, extra);
              return;
            }
            if (method === 'GET' && tail.length === 2) {
              const sha = repo.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
              if (sha === undefined) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              sendJson(res, 200, { name: decodeURIComponent(tail[1]), commit: { sha }, protected: false }, extra);
              return;
            }
          }

          // Commits reachable from ?sha=<branch|oid> (default branch when omitted).
          if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
            const sha = url.searchParams.get('sha') ?? repo.defaultBranch;
            const commits = listCommits(repo, sha).map((entry) => ({
              sha: entry.sha,
              commit: { message: entry.message },
              html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${entry.sha}`,
            }));
            sendJson(res, 200, commits, extra);
            return;
          }

          // Git Data refs: create a ref, read one head ref.
          if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
            if (method === 'POST' && tail.length === 2) {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const ref = typeof body.ref === 'string' ? body.ref : '';
              const sha = typeof body.sha === 'string' ? body.sha : '';
              if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
                sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' }, extra);
                return;
              }
              if (repo.refs.has(ref)) {
                sendJson(res, 422, { message: 'Validation Failed: ref already exists' }, extra);
                return;
              }
              if (!repo.objects.has(sha)) {
                sendJson(res, 422, { message: 'Validation Failed: sha does not exist in this repository' }, extra);
                return;
              }
              repo.refs.set(ref, sha);
              sendJson(res, 201, { ref, object: { sha } }, extra);
              return;
            }
            if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
              const branch = decodeURIComponent(tail[3]);
              const sha = repo.refs.get(`refs/heads/${branch}`);
              if (sha === undefined) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } }, extra);
              return;
            }
          }

          // Contents: PUT creates/updates a file, GET reads a file or directory.
          if (tail.length >= 2 && tail[0] === 'contents') {
            const filePath = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
            if (method === 'PUT') {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const message = typeof body.message === 'string' ? body.message : 'Update file';
              const contentB64 = typeof body.content === 'string' ? body.content : '';
              const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
              const sha = typeof body.sha === 'string' ? body.sha : undefined;
              let content: Buffer;
              try {
                content = Buffer.from(contentB64, 'base64');
              } catch {
                sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' }, extra);
                return;
              }
              const existing = readContentsPath(repo, branch, filePath);
              const isUpdate = existing !== null && existing.kind === 'file';
              if (isUpdate && sha !== undefined && sha !== existing.oid) {
                sendJson(res, 409, { message: 'Conflict: sha does not match the current file' }, extra);
                return;
              }
              if (isUpdate && sha === undefined) {
                sendJson(res, 422, { message: 'Validation Failed: sha is required to update a file' }, extra);
                return;
              }
              const result = commitContents(repo, branch, filePath, content, message, store.viewerLogin ?? owner);
              const contentBody = {
                content: {
                  name: filePath.split('/').pop(),
                  path: filePath,
                  sha: result.blobSha,
                  size: content.length,
                  encoding: 'base64',
                  type: 'file',
                },
                commit: { sha: result.commitSha, message },
              };
              sendJson(res, isUpdate ? 200 : 201, contentBody, extra);
              return;
            }
            if (method === 'DELETE') {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const message = typeof body.message === 'string' ? body.message : 'Delete file';
              const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
              const sha = typeof body.sha === 'string' ? body.sha : undefined;
              const existing = readContentsPath(repo, branch, filePath);
              if (!existing || existing.kind !== 'file') {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (sha !== undefined && sha !== existing.oid) {
                sendJson(res, 409, { message: 'Conflict: sha does not match the current file' }, extra);
                return;
              }
              const result = deletePathCommit(repo, branch, filePath, message, store.viewerLogin ?? owner);
              if ('error' in result) {
                sendJson(res, 404, { message: result.error }, extra);
                return;
              }
              sendJson(res, 200, { commit: { sha: result.commitSha, message } }, extra);
              return;
            }
            if (method === 'GET') {
              const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
              const found = readContentsPath(repo, ref, filePath);
              if (!found) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (found.kind === 'file') {
                sendJson(
                  res,
                  200,
                  {
                    type: 'file',
                    encoding: 'base64',
                    size: found.blob.data.length,
                    name: filePath.split('/').pop(),
                    path: filePath,
                    content: found.blob.data.toString('base64'),
                    sha: found.oid,
                  },
                  extra,
                );
                return;
              }
              sendJson(
                res,
                200,
                found.entries.map((entry) => ({
                  type: entry.mode === '40000' ? 'dir' : 'file',
                  name: entry.name,
                  path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
                  sha: entry.oid,
                  size: 0,
                })),
                extra,
              );
              return;
            }
          }

          // Labels: create one (an issue may only carry a label created here).
          if (tail.length >= 1 && tail[0] === 'labels') {
            if (method === 'POST' && tail.length === 1) {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const name = typeof body.name === 'string' ? body.name : '';
              if (!name) {
                sendJson(res, 422, { message: 'Validation Failed: name is required' }, extra);
                return;
              }
              const existing = repo.labels.find((label) => label.name === name);
              if (existing) {
                sendJson(res, 200, { name: existing.name, color: existing.color, description: existing.description }, extra);
                return;
              }
              const label = {
                name,
                color: typeof body.color === 'string' ? body.color : 'ededed',
                description: typeof body.description === 'string' ? body.description : '',
              };
              repo.labels.push(label);
              sendJson(res, 201, { name: label.name, color: label.color, description: label.description }, extra);
              return;
            }
            if (method === 'GET' && tail.length === 1) {
              sendJson(
                res,
                200,
                repo.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
                extra,
              );
              return;
            }
          }

          // Issues: create (with label validation), list, read, patch, comments.
          if (tail.length >= 1 && tail[0] === 'issues') {
            if (method === 'POST' && tail.length === 1) {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const title = typeof body.title === 'string' ? body.title : '';
              if (!title) {
                sendJson(res, 422, { message: 'Validation Failed: title is required' }, extra);
                return;
              }
              const labelNames = Array.isArray(body.labels)
                ? body.labels.filter((label): label is string => typeof label === 'string')
                : [];
              const unknown = labelNames.filter((name) => !repo.labels.some((label) => label.name === name));
              if (unknown.length) {
                sendJson(res, 422, { message: `Validation Failed: label "${unknown[0]}" does not exist` }, extra);
                return;
              }
              const issue = createIssueRecord(
                store,
                repo,
                title,
                typeof body.body === 'string' ? body.body : '',
                labelNames.map((name) => repo.labels.find((label) => label.name === name)!),
                store.viewerLogin ?? owner,
              );
              sendJson(res, 201, issueJson(repo, issue), extra);
              return;
            }
            if (method === 'GET' && tail.length === 1) {
              const state = url.searchParams.get('state') ?? 'open';
              const sort = url.searchParams.get('sort') ?? 'created';
              const direction = url.searchParams.get('direction') ?? 'desc';
              const list = listIssues(repo, state, sort, direction);
              sendJson(res, 200, list.map((issue) => issueJson(repo, issue)), extra);
              return;
            }
            if (tail.length === 2) {
              const number = Number(tail[1]);
              const issue = repo.issues.find((entry) => entry.number === number);
              if (!issue) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (method === 'GET') {
                sendJson(res, 200, issueJson(repo, issue), extra);
                return;
              }
              if (method === 'PATCH') {
                const raw = await readBody(req);
                const parsed = parseJsonBody(raw);
                if (!parsed.ok) {
                  sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                  return;
                }
                const body = (parsed.value ?? {}) as Record<string, unknown>;
                if (typeof body.state === 'string') {
                  if (body.state !== 'open' && body.state !== 'closed') {
                    sendJson(res, 422, { message: 'Validation Failed: state must be open or closed' }, extra);
                    return;
                  }
                  issue.state = body.state;
                }
                if (typeof body.title === 'string') issue.title = body.title;
                if (typeof body.body === 'string') issue.body = body.body;
                if (Array.isArray(body.labels)) {
                  const labelNames = body.labels.filter((label): label is string => typeof label === 'string');
                  const unknown = labelNames.filter((name) => !repo.labels.some((label) => label.name === name));
                  if (unknown.length) {
                    sendJson(res, 422, { message: `Validation Failed: label "${unknown[0]}" does not exist` }, extra);
                    return;
                  }
                  issue.labels = labelNames.map((name) => repo.labels.find((label) => label.name === name)!);
                }
                issue.updatedAt = new Date().toISOString();
                sendJson(res, 200, issueJson(repo, issue), extra);
                return;
              }
            }
            if (tail.length === 3 && tail[2] === 'comments') {
              const number = Number(tail[1]);
              const issue = repo.issues.find((entry) => entry.number === number);
              if (!issue) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (method === 'POST') {
                const raw = await readBody(req);
                const parsed = parseJsonBody(raw);
                if (!parsed.ok) {
                  sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                  return;
                }
                const body = (parsed.value ?? {}) as Record<string, unknown>;
                const commentBody = typeof body.body === 'string' ? body.body : '';
                if (!commentBody) {
                  sendJson(res, 422, { message: 'Validation Failed: body is required' }, extra);
                  return;
                }
                const comment = createCommentRecord(store, issue, commentBody, store.viewerLogin ?? owner);
                issue.updatedAt = new Date().toISOString();
                sendJson(res, 201, {
                  id: comment.id,
                  node_id: `C_${comment.id}`,
                  body: comment.body,
                  user: { login: comment.userLogin, id: 0, type: 'User' },
                  created_at: comment.createdAt,
                  updated_at: comment.updatedAt,
                  html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
                }, extra);
                return;
              }
              if (method === 'GET') {
                sendJson(
                  res,
                  200,
                  issue.comments.map((comment) => ({
                    id: comment.id,
                    node_id: `C_${comment.id}`,
                    body: comment.body,
                    user: { login: comment.userLogin, id: 0, type: 'User' },
                    created_at: comment.createdAt,
                    updated_at: comment.updatedAt,
                    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
                  })),
                  extra,
                );
                return;
              }
            }
          }

          // Pull requests: create, list, read, files, squash merge.
          if (tail.length >= 1 && tail[0] === 'pulls') {
            if (method === 'POST' && tail.length === 1) {
              const raw = await readBody(req);
              const parsed = parseJsonBody(raw);
              if (!parsed.ok) {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
                return;
              }
              const body = (parsed.value ?? {}) as Record<string, unknown>;
              const title = typeof body.title === 'string' ? body.title : '';
              const head = typeof body.head === 'string' ? body.head : '';
              const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
              if (!title || !head) {
                sendJson(res, 422, { message: 'Validation Failed: title and head are required' }, extra);
                return;
              }
              const result = createPullRecord(store, repo, title, typeof body.body === 'string' ? body.body : '', head, base, store.viewerLogin ?? owner);
              if ('error' in result) {
                sendJson(res, 422, { message: `Validation Failed: ${result.error}` }, extra);
                return;
              }
              sendJson(res, 201, pullJson(repo, result.pull), extra);
              return;
            }
            if (method === 'GET' && tail.length === 1) {
              const state = url.searchParams.get('state') ?? 'open';
              const list = repo.pulls.filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
              sendJson(res, 200, list.map((pull) => pullJson(repo, pull)), extra);
              return;
            }
            if (tail.length === 2) {
              const number = Number(tail[1]);
              const pull = repo.pulls.find((entry) => entry.number === number);
              if (!pull) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (method === 'GET') {
                sendJson(res, 200, pullJson(repo, pull), extra);
                return;
              }
            }
            if (tail.length === 3 && tail[2] === 'files') {
              const number = Number(tail[1]);
              const pull = repo.pulls.find((entry) => entry.number === number);
              if (!pull) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (method === 'GET') {
                const files = pullFiles(repo, pull).map((change) => ({
                  filename: change.path,
                  status: change.status,
                  additions: change.additions,
                  deletions: change.deletions,
                  changes: change.additions + change.deletions,
                  sha: change.newOid ?? change.oldOid,
                }));
                sendJson(res, 200, files, extra);
                return;
              }
            }
            if (tail.length === 3 && tail[2] === 'merge') {
              const number = Number(tail[1]);
              const pull = repo.pulls.find((entry) => entry.number === number);
              if (!pull) {
                sendJson(res, 404, { message: 'Not Found' }, extra);
                return;
              }
              if (method === 'PUT') {
                if (pull.state !== 'open') {
                  sendJson(res, 405, { message: 'Method Not Allowed: the pull request is not open' }, extra);
                  return;
                }
                const outcome = squashMerge(repo, pull, store.viewerLogin ?? owner);
                if ('conflict' in outcome) {
                  sendJson(res, 405, { message: `Merge conflict: ${outcome.conflict}` }, extra);
                  return;
                }
                sendJson(res, 200, { merged: true, sha: outcome.mergeSha, message: `Merged pull request #${pull.number}` }, extra);
                return;
              }
            }
          }

          sendJson(res, 404, { message: 'Not Found' }, extra);
          return;
        }

        // Any other /api/v3 route: a JSON 404, never HTML.
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0 && !parseJsonBody(raw).ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
            return;
          }
        }
        sendJson(res, 404, { message: 'Not Found' }, extra);
        return;
      }

      // GraphQL v4: POST /api/graphql (single or batched documents).
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, extra);
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, extra);
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, extra);
          return;
        }
        try {
          const result = executeGraphQL(parsed.value, store);
          sendJson(res, 200, result, extra);
        } catch (err) {
          sendJson(res, 200, { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] }, extra);
        }
        return;
      }

      // MCP: POST /mcp (JSON-RPC 2.0), DELETE closes a legacy session.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method === 'DELETE') {
          res.writeHead(204, { ...extra });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, extra);
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, extra);
          return;
        }
        const raw = await readBody(req);
        const outcome = handleMcp(store, raw);
        if (outcome.body === null) {
          res.writeHead(outcome.status, { ...extra });
          res.end();
          return;
        }
        const headers: Record<string, string> = { ...extra };
        if (outcome.sessionId !== null) headers['mcp-session-id'] = outcome.sessionId;
        sendJson(res, outcome.status, outcome.body, headers);
        return;
      }

      // Everything else: a JSON 404.
      sendJson(res, 404, { message: 'Not Found' }, extra);
    })().catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });

  return server;
}
