// mcp.ts — the MCP endpoint for the forge: JSON-RPC 2.0 over POST /mcp, Streamable HTTP
// transport, modern era (server/discover, revision 2026-07-28) plus the legacy initialize
// handshake. Six tools (create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request) act on the same store as REST and GraphQL.

import {
  createCommentRecord,
  createIssueRecord,
  createPullRecord,
  issueJson,
  listIssues,
  pullJson,
  repoJson,
  squashMerge,
} from './rest.ts';
import type { Repo, Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(store: Store, owner: unknown, repoName: unknown): Repo | undefined {
  if (typeof owner !== 'string' || typeof repoName !== 'string') return undefined;
  return store.getRepo(owner, repoName);
}

/** Run one tool call against the store; returns the tool result object. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const viewer = store.viewerLogin ?? '';
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
        return toolError('create_repo: name is required and must be a valid repository name');
      }
      if (typeof args.owner === 'string' && args.owner !== '') store.setViewerLogin(args.owner);
      if (store.repos.has(repoName)) return toolError(`create_repo: a repository named ${repoName} already exists`);
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args.owner, args.repo);
      if (!repo) return toolError('get_repo: repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(store, args.owner, args.repo);
      if (!repo) return toolError('create_issue: repository not found');
      if (typeof args.title !== 'string' || args.title === '') return toolError('create_issue: title is required');
      const issue = createIssueRecord(store, repo, args.title, typeof args.body === 'string' ? args.body : '', [], viewer);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(store, args.owner, args.repo);
      if (!repo) return toolError('list_issues: repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = listIssues(repo, state, 'created', 'desc');
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args.owner, args.repo);
      if (!repo) return toolError('create_pull_request: repository not found');
      const result = createPullRecord(
        store,
        repo,
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        typeof args.head === 'string' ? args.head : '',
        typeof args.base === 'string' ? args.base : '',
        viewer,
      );
      if ('error' in result) return toolError(`create_pull_request: ${result.error}`);
      return toolResult(pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args.owner, args.repo);
      if (!repo) return toolError('merge_pull_request: repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return toolError(`merge_pull_request: pull request #${String(args.pull_number)} not found`);
      if (pull.state !== 'open') return toolError('merge_pull_request: the pull request is not open');
      const outcome = squashMerge(repo, pull, viewer);
      if ('conflict' in outcome) return toolError(`merge_pull_request: ${outcome.conflict}`);
      return toolResult({ merged: true, sha: outcome.mergeSha, message: `Merged pull request #${pull.number}`, ...pullJson(repo, pull) });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpOutcome {
  status: number;
  body: unknown;
  /** A session id to hand out on the initialize answer (legacy era), or null. */
  sessionId: string | null;
}

let sessionCounter = 0;

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Handle one POST /mcp body. `raw` is the exact request text (a body that is not JSON is a
 * -32700 parse error with HTTP 400). Returns the HTTP status, the JSON body, and an optional
 * session id for the response header.
 */
export function handleMcp(store: Store, raw: Buffer): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    let id: unknown = null;
    const match = /"id"\s*:\s*(\d+)/.exec(raw.toString('utf8'));
    if (match) id = Number(match[1]);
    return { status: 400, body: rpcError(id, -32700, 'Parse error'), sessionId: null };
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    return { status: 400, body: rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'), sessionId: null };
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};

  // A notification (no id) is answered with 202 and no body.
  if (body.id === undefined) {
    return { status: 202, body: null, sessionId: null };
  }

  switch (body.method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [MCP_REVISION],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
        sessionId: null,
      };
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : '2025-06-18';
      sessionCounter += 1;
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
        sessionId: `mcp-${sessionCounter}`,
      };
    }
    case 'tools/list': {
      // One constant array: two calls answer byte-identical tools.
      return { status: 200, body: rpcResult(id, { tools: TOOLS }), sessionId: null };
    }
    case 'tools/call': {
      const toolName = params.name;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (typeof toolName !== 'string' || toolName === '') {
        return { status: 200, body: rpcError(id, -32602, 'Invalid params: tools/call needs a tool name'), sessionId: null };
      }
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (!tool) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`), sessionId: null };
      }
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcResult(id, toolError(`tools/call ${toolName} is missing required argument(s): ${missing.join(', ')}`)), sessionId: null };
      }
      return { status: 200, body: rpcResult(id, callTool(store, toolName, args)), sessionId: null };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}), sessionId: null };
    }
    default: {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${body.method}`), sessionId: null };
    }
  }
}

export { createCommentRecord };
