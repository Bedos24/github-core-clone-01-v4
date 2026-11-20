// rest.ts — the shared forge domain behind REST v3, GraphQL v4 and MCP: pull requests,
// squash merges, tree diffs, issue comments, and the JSON shapes all three surfaces read.
// No HTTP here; app.ts, graphql.ts and mcp.ts call these helpers.

import {
  buildCommit,
  buildTree,
  collectReachable,
  forgeIdentity,
  hashObject,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
  type TreeEntry,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// JSON shapes (the GitHub v3 shapes the conformance suite asserts)
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
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

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelJson(label)),
    user: { login: issue.userLogin, id: 0, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: 0, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

/** The branch tip a pull request's head/base currently points at. */
export function branchTip(repo: Repo, branch: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${repo.owner}:${pull.headBranch}`, ref: pull.headBranch, sha: branchTip(repo, pull.headBranch) },
    base: { label: `${repo.owner}:${pull.baseBranch}`, ref: pull.baseBranch, sha: branchTip(repo, pull.baseBranch) },
    user: { login: pull.userLogin, id: 0, type: 'User' },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// issue and pull-request records
// ---------------------------------------------------------------------------------------------

export function createIssueRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: Label[],
  userLogin: string,
): Issue {
  const now = new Date().toISOString();
  const issue: Issue = {
    id: store.nextIssueIdFor(),
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels,
    userLogin,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return issue;
}

export function createCommentRecord(store: Store, issue: Issue, body: string, userLogin: string): IssueComment {
  const now = new Date().toISOString();
  const comment: IssueComment = { id: store.nextCommentIdFor(), body, userLogin, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return comment;
}

/** Issues filtered by state and ordered by creation (number breaks same-millisecond ties). */
export function listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
  const filtered = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const asc = direction === 'asc';
  const byUpdated = sort === 'updated';
  filtered.sort((a, b) => {
    const aKey = byUpdated ? a.updatedAt : a.createdAt;
    const bKey = byUpdated ? b.updatedAt : b.createdAt;
    if (aKey !== bKey) return asc ? (aKey < bKey ? -1 : 1) : (aKey < bKey ? 1 : -1);
    return asc ? a.number - b.number : b.number - a.number;
  });
  return filtered;
}

/**
 * Create a pull request. Returns the record, or a human-readable refusal (unknown branch,
 * head equal to base, or an already-open pull request from the same head).
 */
export function createPullRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
  userLogin: string,
): { pull: PullRequest } | { error: string } {
  if (!repo.refs.has(`refs/heads/${headBranch}`)) return { error: `head branch ${headBranch} does not exist` };
  if (!repo.refs.has(`refs/heads/${baseBranch}`)) return { error: `base branch ${baseBranch} does not exist` };
  if (headBranch === baseBranch) return { error: 'head and base are the same branch' };
  const duplicate = repo.pulls.find((pull) => pull.headBranch === headBranch && pull.baseBranch === baseBranch && pull.state === 'open');
  if (duplicate) return { error: `a pull request from ${headBranch} is already open (#${duplicate.number})` };
  const now = new Date().toISOString();
  const pull: PullRequest = {
    id: store.nextPullIdFor(),
    number: repo.nextPullNumber,
    title,
    body,
    state: 'open',
    headBranch,
    baseBranch,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextPullNumber += 1;
  repo.pulls.push(pull);
  return { pull };
}

// ---------------------------------------------------------------------------------------------
// trees: flatten, diff, three-way merge
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** A commit's tree, flattened to path -> entry (gitlinks skipped). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Multiset line diff: lines in the new blob that the old one lacks, and vice versa. */
function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldBag = new Map<string, number>();
  for (const line of oldLines) oldBag.set(line, (oldBag.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldBag.get(line) ?? 0;
    if (left > 0) oldBag.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldBag.values()) deletions += left;
  return { additions, deletions };
}

function blobText(repo: Repo, oid: string | null): string {
  if (oid === null) return '';
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** The file changes from `baseTree` to `headTree`, with line counts. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to === undefined) {
      const counts = lineCounts(blobText(repo, from.oid), '');
      changes.push({ path, status: 'removed', oldOid: from.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (from === undefined && to !== undefined) {
      const counts = lineCounts('', blobText(repo, to.oid));
      changes.push({ path, status: 'added', oldOid: null, newOid: to.oid, additions: counts.additions, deletions: 0 });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const counts = lineCounts(blobText(repo, from.oid), blobText(repo, to.oid));
      changes.push({ path, status: 'modified', oldOid: from.oid, newOid: to.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/** The nearest common ancestor of two commits (breadth-first from `head`, against `base`'s ancestors). */
export function mergeBase(repo: Repo, headOid: string, baseOid: string): string | null {
  const baseAncestors = new Set<string>();
  const queue: string[] = [baseOid];
  while (queue.length) {
    const oid = queue.pop()!;
    if (baseAncestors.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    baseAncestors.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const headQueue: string[] = [headOid];
  const seen = new Set<string>();
  while (headQueue.length) {
    const oid = headQueue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) headQueue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// squash merge
// ---------------------------------------------------------------------------------------------

/** Replace one path in a tree (or delete it when `blobOid` is null), pruning emptied directories. */
export function setTreePath(repo: Repo, treeOid: string | undefined, segments: readonly string[], blobOid: string | null, mode: string): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid !== undefined) {
    const object = repo.objects.get(treeOid);
    if (object && object.type === 'tree') {
      for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
    }
  }
  const name = segments[0];
  if (segments.length === 1) {
    if (blobOid === null) entries.delete(name);
    else entries.set(name, { mode, name, oid: blobOid });
  } else {
    const child = entries.get(name);
    const childOid = setTreePath(repo, child?.mode === '40000' ? child.oid : undefined, segments.slice(1), blobOid, mode);
    const childObject = repo.objects.get(childOid);
    const childEntries = childObject && childObject.type === 'tree' ? parseTree(childObject.data) : [];
    if (childEntries.length === 0) entries.delete(name);
    else entries.set(name, { mode: '40000', name, oid: childOid });
  }
  const treeData = buildTree([...entries.values()]);
  const treeSha = hashObject('tree', treeData);
  if (!repo.objects.has(treeSha)) repo.objects.set(treeSha, { type: 'tree', data: treeData });
  return treeSha;
}

/** Remove one path from a branch tip's tree and commit the result on that branch. */
export function deletePathCommit(repo: Repo, branch: string, path: string, message: string, authorLogin: string): { commitSha: string } | { error: string } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return { error: `branch ${branch} does not exist` };
  const tree = treeOfCommit(repo, tip);
  if (tree === null) return { error: `branch ${branch} has no commit` };
  const flat = flattenTree(repo, tree);
  if (!flat.has(path)) return { error: `path ${path} does not exist on ${branch}` };
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const newTree = setTreePath(repo, tree, segments, null, '100644');
  const epochSec = Math.floor(Date.now() / 1000);
  const identity = forgeIdentity(authorLogin, epochSec);
  const commitData = buildCommit({ tree: newTree, parents: [tip], author: identity, committer: identity, message: message.endsWith('\n') ? message : `${message}\n` });
  const commitSha = hashObject('commit', commitData);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha };
}

export type MergeOutcome = { mergeSha: string } | { conflict: string };

/**
 * Squash-merge an open pull request onto its base branch's *current* tip: the merge base is
 * recomputed at merge time, a path changed on both sides to different bytes conflicts, and the
 * squash commit's parent is the current base tip (never the base sha from PR creation).
 */
export function squashMerge(repo: Repo, pull: PullRequest, authorLogin: string): MergeOutcome {
  const headTip = repo.refs.get(`refs/heads/${pull.headBranch}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`);
  if (headTip === undefined || baseTip === undefined) return { conflict: 'a branch of this pull request no longer exists' };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { conflict: 'the branches share no common ancestor' };
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  const currentBaseTree = treeOfCommit(repo, baseTip);
  if (baseTree === null || headTree === null || currentBaseTree === null) return { conflict: 'a branch tip is not a commit' };
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, currentBaseTree);
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other === undefined) continue;
    if (other.newOid !== change.newOid) {
      return { conflict: `both sides changed ${change.path}` };
    }
  }
  let resultTree = currentBaseTree;
  for (const change of headChanges) {
    const segments = change.path.split('/').filter((segment) => segment.length > 0);
    const flat = flattenTree(repo, headTree);
    const mode = flat.get(change.path)?.mode ?? '100644';
    resultTree = setTreePath(repo, resultTree, segments, change.newOid, mode);
  }
  const epochSec = Math.floor(Date.now() / 1000);
  const identity = forgeIdentity(authorLogin, epochSec);
  const message = `Merge pull request #${pull.number} from ${pull.headBranch}\n\n${pull.title}\n`;
  const commitData = buildCommit({ tree: resultTree, parents: [baseTip], author: identity, committer: identity, message });
  const mergeSha = hashObject('commit', commitData);
  if (!repo.objects.has(mergeSha)) repo.objects.set(mergeSha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseBranch}`, mergeSha);
  const now = new Date().toISOString();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = now;
  return { mergeSha };
}

/** Whether a pull request would merge cleanly right now (its GraphQL `mergeable`). */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headBranch}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  const currentBaseTree = treeOfCommit(repo, baseTip);
  if (baseTree === null || headTree === null || currentBaseTree === null) return 'UNKNOWN';
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanged = new Map(diffTrees(repo, baseTree, currentBaseTree).map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** The changed files of a pull request (base tip at creation vs head tip now, via their merge base). */
export function pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headBranch}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseBranch}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return [];
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  if (baseTree === null || headTree === null) return [];
  return diffTrees(repo, baseTree, headTree);
}

/** Commits reachable from `from` (a branch name or oid), tip first, parents after. */
export function listCommits(repo: Repo, from: string): { sha: string; message: string }[] {
  let tip = repo.refs.get(`refs/heads/${from}`);
  if (tip === undefined && /^[0-9a-f]{40}$/.test(from)) tip = from;
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return [];
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    out.push({ sha: oid, message: view.message.replace(/\n$/, '') });
    for (const parent of view.parents) queue.push(parent);
  }
  return out;
}

/** All objects reachable from a commit, for a pack or a file count. */
export function reachableObjects(repo: Repo, oid: string): Set<string> {
  return collectReachable([oid], (wanted) => repo.objects.get(wanted));
}

export type { GitObject };
