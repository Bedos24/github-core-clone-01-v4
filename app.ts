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
import { Store, type Issue, type Repo } from './store.ts';

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

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: issue.userLogin, id: 0, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: 0,
  };
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

          // Issues: create (with label validation) and list.
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
              const now = new Date().toISOString();
              const issue: Issue = {
                id: store.nextIssueIdFor(),
                number: repo.nextIssueNumber,
                title,
                body: typeof body.body === 'string' ? body.body : '',
                state: 'open',
                labels: labelNames.map((name) => repo.labels.find((label) => label.name === name)!),
                userLogin: store.viewerLogin ?? owner,
                createdAt: now,
                updatedAt: now,
              };
              repo.nextIssueNumber += 1;
              repo.issues.push(issue);
              sendJson(res, 201, issueJson(repo, issue), extra);
              return;
            }
            if (method === 'GET' && tail.length === 1) {
              const state = url.searchParams.get('state') ?? 'open';
              const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
              sendJson(res, 200, list.map((issue) => issueJson(repo, issue)), extra);
              return;
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
