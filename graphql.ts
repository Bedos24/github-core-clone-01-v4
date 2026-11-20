// graphql.ts — GraphQL v4 for the forge: a hand-written lexer/parser for the document subset
// gh and github-mcp-server send, a small schema, and an executor over the shared store.
// No dependency, no code generation. Serves POST /api/graphql (single or batched documents).

import {
  createCommentRecord,
  createIssueRecord,
  createPullRecord,
  diffTrees,
  flattenTree,
  listIssues,
  mergeBase,
  pullFiles,
  pullMergeable,
  squashMerge,
  treeOfCommit,
} from './rest.ts';
import {
  parseCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: input.slice(i, j) } : { kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser: documents, operations, fragments, values
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeName: string | null; selections: SelectionNode[] };

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefs: { name: string; type: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeName: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? 'a name'} in GraphQL document`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefs: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variableDefs: OperationNode['variableDefs'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefs.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { kind, name, variableDefs, selections: this.parseSelectionSet() };
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeName = this.expectName();
    this.skipDirectives();
    return { name, typeName, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeName, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeName: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'repository'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  User: ['login', 'id'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const TYPE_KIND: Readonly<Record<string, string>> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  PageInfo: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  IssueComment: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  SearchType: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  Node: 'INTERFACE',
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'WIKI'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GqlValue {
  __typename: string;
  [key: string]: unknown;
}

class GqlError extends Error {}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoById(store: Store, id: string): { repo: Repo } | null {
  const match = /^R_(\d+)$/.exec(id);
  if (match) {
    for (const repo of store.repos.values()) if (repo.id === Number(match[1])) return { repo };
    return null;
  }
  const numeric = Number(id);
  if (Number.isInteger(numeric)) {
    for (const repo of store.repos.values()) if (repo.id === numeric) return { repo };
  }
  return null;
}

function issueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const match = /^I_(\d+)$/.exec(id);
  if (!match) return null;
  const wanted = Number(match[1]);
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) if (issue.id === wanted) return { repo, issue };
  }
  return null;
}

function pullById(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const match = /^PR_(\d+)$/.exec(id);
  if (!match) return null;
  const wanted = Number(match[1]);
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) if (pull.id === wanted) return { repo, pull };
  }
  return null;
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', __repo: repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(repo: Repo, pull: PullRequest): GqlValue {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userValue(login: string): GqlValue {
  return { __typename: 'User', login };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function argMap(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function executeSelections(parent: GqlValue, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = resolveField(parent, field, ctx);
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) throw new GqlError(`unknown fragment ${selection.name}`);
      if (fragment.typeName !== parent.__typename && fragment.typeName !== 'Node') continue;
      Object.assign(out, executeSelections(parent, fragment.selections, ctx));
    } else if (selection.kind === 'inline') {
      if (selection.typeName !== null && selection.typeName !== parent.__typename && selection.typeName !== 'Node') continue;
      Object.assign(out, executeSelections(parent, selection.selections, ctx));
    }
  }
  return out;
}

function resolveField(parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const typeName = parent.__typename;
  if (field.name === '__typename') return typeName;
  const known = FIELDS[typeName];
  if (known === undefined || !known.includes(field.name)) {
    throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}"`);
  }
  const args = argMap(field, ctx);
  const store = ctx.store;
  const sub = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || !('__typename' in (value as Record<string, unknown>))) return value;
    return executeSelections(value as GqlValue, field.selections, ctx);
  };
  const subList = (values: unknown[]): unknown[] => values.map((value) => sub(value));

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return sub(userValue(store.viewerLogin ?? ''));
      }
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return sub(repoValue(repo));
      }
      if (field.name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const repo = repoById(store, id);
        if (repo) return sub(repoValue(repo.repo));
        const issue = issueById(store, id);
        if (issue) return sub(issueValue(issue.repo, issue.issue));
        const pull = pullById(store, id);
        if (pull) return sub(pullValue(pull.repo, pull.pull));
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        return sub(introspectionType(name));
      }
      if (field.name === '__schema') {
        return sub(introspectionSchema());
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(parent, field, ctx);
    }
    case 'Repository': {
      const repo = parent.__repo as Repo;
      switch (field.name) {
        case 'id':
          return `R_${repo.id}`;
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return sub(userValue(repo.owner));
        case 'description':
          return repo.description;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return sub({ __typename: 'Ref', name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue ? sub(issueValue(repo, issue)) : null;
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const stateFilter = states === null ? 'all' : states.includes('OPEN') && states.includes('CLOSED') ? 'all' : states.includes('OPEN') ? 'open' : 'closed';
          const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
          const sort = orderBy.field === 'UPDATED_AT' ? 'updated' : 'created';
          const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
          const ordered = listIssues(repo, stateFilter, sort, direction);
          const after = cursorNumber(args.after);
          let start = 0;
          if (after !== null) {
            const index = ordered.findIndex((issue) => issue.number === after);
            start = index < 0 ? ordered.length : index + 1;
          }
          const first = typeof args.first === 'number' ? args.first : ordered.length;
          const page = ordered.slice(start, start + Math.max(0, first));
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
          return sub({
            __typename: 'IssueConnection',
            nodes: page.map((issue) => issueValue(repo, issue)),
            edges: page.map((issue) => ({ __typename: 'IssueCommentEdge', node: issueValue(repo, issue), cursor: cursorFor(issue.number) })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: start + page.length < ordered.length, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorFor(page[0].number) : null, endCursor },
            totalCount: ordered.length,
          });
        }
        case 'pullRequests': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          let pulls = repo.pulls;
          if (states !== null) {
            pulls = pulls.filter((pull) => states.includes(pullState(pull)));
          }
          const first = typeof args.first === 'number' ? args.first : pulls.length;
          const page = pulls.slice(0, Math.max(0, first));
          return sub({
            __typename: 'PullRequestConnection',
            nodes: page.map((pull) => pullValue(repo, pull)),
            edges: page.map((pull) => ({ __typename: 'IssueCommentEdge', node: pullValue(repo, pull), cursor: cursorFor(pull.number) })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: pulls.length,
          });
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull ? sub(pullValue(repo, pull)) : null;
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = parent.__repo as Repo;
      const issue = parent.__issue as Issue;
      switch (field.name) {
        case 'id':
          return `I_${issue.id}`;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return sub(userValue(issue.userLogin));
        case 'repository':
          return sub(repoValue(repo));
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = parent.__repo as Repo;
      const pull = parent.__pull as PullRequest;
      switch (field.name) {
        case 'id':
          return `PR_${pull.id}`;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headBranch;
        case 'baseRefName':
          return pull.baseBranch;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'author':
          return sub(userValue(pull.userLogin));
        case 'repository':
          return sub(repoValue(repo));
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const changes = pullFiles(repo, pull);
          const page = first === undefined ? changes : changes.slice(0, Math.max(0, first));
          return sub({
            __typename: 'PullRequestConnection',
            nodes: page.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: change.additions, deletions: change.deletions })),
            edges: [],
            pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && changes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: changes.length,
          });
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const nodes = parent.nodes as unknown[];
      switch (field.name) {
        case 'nodes':
          return subList(nodes);
        case 'edges':
          return subList(parent.edges as unknown[]);
        case 'pageInfo':
          return sub(parent.pageInfo as GqlValue);
        case 'totalCount':
          return parent.totalCount as number;
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path as string;
      if (field.name === 'additions') return parent.additions as number;
      if (field.name === 'deletions') return parent.deletions as number;
      return null;
    }
    case 'User': {
      if (field.name === 'login') return parent.login as string;
      if (field.name === 'id') return `U_${parent.login as string}`;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name as string;
      return null;
    }
    case 'PageInfo': {
      return parent[field.name] ?? null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return sub(parent.node as GqlValue);
      if (field.name === 'cursor') return parent.cursor as string;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return parent.id as string;
      if (field.name === 'body') return parent.body as string;
      if (field.name === 'createdAt') return parent.createdAt as string;
      if (field.name === 'updatedAt') return parent.updatedAt as string;
      if (field.name === 'author') return sub(userValue(parent.userLogin as string));
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return parent.name as string;
      if (field.name === 'kind') return parent.kind as string;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = (parent.fieldNames as string[]) ?? [];
        return subList(names.map((name) => ({ __typename: '__Field', name, description: null, args: [], type: { __typename: '__Type', name: 'String', kind: 'SCALAR', fieldNames: [], enumNames: [] }, isDeprecated: false, deprecationReason: null })));
      }
      if (field.name === 'enumValues') {
        const names = (parent.enumNames as string[]) ?? [];
        return subList(names.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null })));
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name as string;
      if (field.name === 'description') return parent.description ?? null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return sub(parent.type as GqlValue);
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name as string;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return sub({ __typename: '__Type', name: 'Query', kind: 'OBJECT', fieldNames: FIELDS.Query, enumNames: [] });
      if (field.name === 'mutationType') return sub({ __typename: '__Type', name: 'Mutation', kind: 'OBJECT', fieldNames: FIELDS.Mutation, enumNames: [] });
      if (field.name === 'types') {
        return subList(Object.keys(FIELDS).map((name) => introspectionType(name)));
      }
      return null;
    }
    default: {
      // Payload objects and edges: their fields are plain values or nested nodes.
      const value = parent[field.name];
      if (value === null || value === undefined) return null;
      if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) return sub(value as GqlValue);
      if (Array.isArray(value)) return subList(value);
      return value;
    }
  }
}

function introspectionType(name: string): GqlValue {
  return {
    __typename: '__Type',
    name,
    kind: TYPE_KIND[name] ?? 'OBJECT',
    fieldNames: FIELDS[name] ?? [],
    enumNames: ENUM_VALUES[name] ?? [],
  };
}

function introspectionSchema(): GqlValue {
  return { __typename: '__Schema' };
}

function resolveMutation(parent: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const store = ctx.store;
  const args = argMap(field, ctx);
  const input = isRecord(args.input) ? args.input : {};
  const viewer = store.viewerLogin ?? '';
  const sub = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) return executeSelections(value as GqlValue, field.selections, ctx);
    return value;
  };

  if (field.name === 'createIssue') {
    const repo = typeof input.repositoryId === 'string' ? repoById(store, input.repositoryId)?.repo : undefined;
    if (!repo) throw new GqlError('createIssue: repositoryId does not name a repository');
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') throw new GqlError('createIssue: title is required');
    const issue = createIssueRecord(store, repo, title, typeof input.body === 'string' ? input.body : '', [], viewer);
    return sub({ __typename: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  }
  if (field.name === 'closeIssue') {
    const found = typeof input.issueId === 'string' ? issueById(store, input.issueId) : null;
    if (!found) throw new GqlError('closeIssue: issueId does not name an issue');
    found.issue.state = 'closed';
    found.issue.updatedAt = new Date().toISOString();
    return sub({ __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  }
  if (field.name === 'createPullRequest') {
    const repo = typeof input.repositoryId === 'string' ? repoById(store, input.repositoryId)?.repo : undefined;
    if (!repo) throw new GqlError('createPullRequest: repositoryId does not name a repository');
    const result = createPullRecord(
      store,
      repo,
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
      typeof input.headRefName === 'string' ? input.headRefName : '',
      typeof input.baseRefName === 'string' ? input.baseRefName : '',
      viewer,
    );
    if ('error' in result) throw new GqlError(`createPullRequest: ${result.error}`);
    return sub({ __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, result.pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  }
  if (field.name === 'mergePullRequest') {
    const found = typeof input.pullRequestId === 'string' ? pullById(store, input.pullRequestId) : null;
    if (!found) throw new GqlError('mergePullRequest: pullRequestId does not name a pull request');
    if (found.pull.state !== 'open') throw new GqlError('mergePullRequest: the pull request is not open');
    const outcome = squashMerge(found.repo, found.pull, viewer);
    if ('conflict' in outcome) throw new GqlError(`mergePullRequest: ${outcome.conflict}`);
    return sub({ __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  }
  if (field.name === 'addComment') {
    const found = typeof input.subjectId === 'string' ? issueById(store, input.subjectId) : null;
    if (!found) throw new GqlError('addComment: subjectId does not name an issue');
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = createCommentRecord(store, found.issue, body, viewer);
    const node: GqlValue = { __typename: 'IssueComment', id: `C_${comment.id}`, body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, userLogin: viewer };
    return sub({ __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// entry point: one operation document (or a batch of them) -> response objects
// ---------------------------------------------------------------------------------------------

export interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function runOperation(doc: DocumentNode, operationName: string | undefined, variables: Record<string, unknown>, store: Store): GqlResponse {
  const operation = operationName !== undefined
    ? doc.operations.find((entry) => entry.name === operationName)
    : doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation found in the document' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.variableDefs) {
    if (!(def.name in vars) && def.defaultValue !== null) vars[def.name] = valueOf(def.defaultValue, vars);
  }
  const ctx: ExecContext = { store, variables: vars, fragments: doc.fragments };
  const root: GqlValue = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  try {
    const data = executeSelections(root, operation.selections, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

/**
 * Execute a parsed GraphQL request body. `body` is one {query, variables, operationName} object
 * or an array of them (batching); the answer mirrors that shape.
 */
export function executeGraphQL(body: unknown, store: Store): GqlResponse | GqlResponse[] {
  const runOne = (entry: unknown): GqlResponse => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'the request body must carry a query string' }] };
    }
    let doc: DocumentNode;
    try {
      doc = new Parser(lex(entry.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return runOperation(doc, operationName, variables, store);
  };
  if (Array.isArray(body)) return body.map((entry) => runOne(entry));
  return runOne(body);
}

export { diffTrees, flattenTree, mergeBase, treeOfCommit };
export type { Issue, PullRequest, Repo };
