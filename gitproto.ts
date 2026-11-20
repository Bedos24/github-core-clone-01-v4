// gitproto.ts — git smart HTTP: protocol v2/v0 upload-pack (ls-refs, fetch incl.
// shallow/deepen), v0 receive-pack with per-ref report-status, and the pack
// planning (what a fetch sends, which commits stay shallow).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  packetLines,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type Repo,
  type TreeEntry,
} from './store.ts';

export const AGENT = 'github-core-clone/1.0';
const SIDEBAND_CHUNK = 32768;

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function peelTarget(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  const tag = parseTag(object.data);
  let current = tag.object;
  for (let depth = 0; depth < 10; depth += 1) {
    const next = repo.objects.get(current);
    if (!next || next.type !== 'tag') return current;
    current = parseTag(next.data).object;
  }
  return current;
}

/** HEAD's target: the default branch, always `refs/heads/main` here. */
export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The oid HEAD resolves to, or the zero oid when the repo is unborn. */
export function headOid(repo: Repo): string {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const UPLOAD_V2_CAPS = ['agent=github-core-clone/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n', ...UPLOAD_V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
  return encodePktLines(lines);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headTarget(repo)} side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const names = sortedRefNames(repo);
  const lines: string[] = [];
  if (names.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      lines.push(`${oid} ${name}\n`);
      const peeled = peelTarget(repo, oid);
      if (peeled !== undefined && name.startsWith('refs/tags/')) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  for (const line of lines) parts.push(encodePktLine(line));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): HttpResult {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

function sidebandPackets(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  if (pack.length === 0) {
    parts.push(encodePktLine(Buffer.from([1])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in walk order. */
  objects: GitObject[];
  /** Commits that stay (or become) shallow boundaries after this fetch. */
  shallow: string[];
  /** Commits that were shallow and no longer are. */
  unshallow: string[];
}

/**
 * The set of objects the client already holds: the closure of its `haves`, except a
 * have that is one of its shallow boundaries contributes only itself — its parents
 * are not held, so a fetch must not subtract objects reachable past it.
 */
function heldObjects(repo: Repo, haves: readonly string[], clientShallow: readonly string[]): Set<string> {
  const shallowSet = new Set(clientShallow);
  const held = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) if (isObjectId(have)) queue.push(have);
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return held;
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const held = heldObjects(repo, haves, clientShallow);
  const shallowSet = new Set(clientShallow);
  const stopAt = (oid: string): boolean => held.has(oid) || shallowSet.has(oid);

  // Walk from the wants, generation by generation; a commit at generation depth-1
  // (depth counts the want as generation 0) is a boundary: kept, parents cut.
  // A commit's tree closure is added only for commits that are kept.
  const send = new Map<string, GitObject>();
  const keptBoundaries = new Set<string>();
  const walkQueue: Array<{ oid: string; generation: number }> = [];
  for (const want of wants) {
    if (isObjectId(want)) walkQueue.push({ oid: want, generation: 0 });
  }
  const visited = new Set<string>();
  const addClosure = (root: string): void => {
    for (const id of collectReachable([root], (oid) => repo.objects.get(oid), { allowMissing: true })) {
      const obj = repo.objects.get(id);
      if (!obj || held.has(id)) continue;
      // Never add a commit other than the root of this closure: parents are added
      // by the outer walk, generation by generation.
      if (obj.type === 'commit' && id !== root) continue;
      send.set(id, obj);
    }
  };
  while (walkQueue.length) {
    const { oid, generation } = walkQueue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      if (!held.has(oid)) send.set(oid, object);
      walkQueue.push({ oid: parseTag(object.data).object, generation });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (stopAt(oid)) continue;
    if (depth !== undefined && generation >= depth) continue;
    addClosure(oid);
    if (depth !== undefined && generation === depth - 1) {
      keptBoundaries.add(oid);
      continue;
    }
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) walkQueue.push({ oid: parent, generation: generation + 1 });
  }
  // Which of the client's old shallow commits are still boundaries: held, and
  // their parents still missing from what the client holds after this fetch.
  const clientAfter = new Set<string>([...held, ...send.keys(), ...clientShallow]);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const old of clientShallow) {
    const object = repo.objects.get(old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const stillCut = parents.some((parent) => !clientAfter.has(parent));
    if (stillCut && !keptBoundaries.has(old)) shallow.push(old);
    else if (!stillCut) unshallow.push(old);
  }
  for (const boundary of keptBoundaries) {
    if (!shallow.includes(boundary)) shallow.push(boundary);
  }
  return { objects: [...send.values()], shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function fetchResponseV2(repo: Repo, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(Buffer.from('0001', 'ascii'));
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPackets(writePack(plan.objects)));
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPackets(writePack(plan.objects)));
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const head = headOid(repo);
  const target = headTarget(repo);
  const match = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  if (head === ZERO_OID) {
    if (match('HEAD')) lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:${target}` : ''}\n`);
  } else if (match('HEAD')) {
    lines.push(`${head} HEAD${opts.symrefs ? ` symref-target:${target}` : ''}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!match(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const peeled = peelTarget(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo, body: Buffer, wantsV2: boolean): HttpResult {
  const contentType = 'application/x-git-upload-pack-result';
  const { packets } = decodePktLines(body);
  const lines = packetLines(packets);
  if (wantsV2) {
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const headerLines = delimIndex < 0 ? lines : packetLines(packets.slice(0, delimIndex));
    const argLines = delimIndex < 0 ? [] : packetLines(packets.slice(delimIndex + 1));
    const commandLine = headerLines.find((line) => line.startsWith('command=')) ?? '';
    const command = commandLine.slice('command='.length);
    if (command === 'ls-refs') {
      const peel = argLines.includes('peel');
      const symrefs = argLines.includes('symrefs');
      const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
      return { status: 200, contentType, body: lsRefsResponse(repo, { peel, symrefs, prefixes }) };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const line of argLines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number.parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(n) && n > 0) depth = n;
        }
      }
      const plan = planFetch(repo, wants, haves, shallow, depth);
      return { status: 200, contentType, body: fetchResponseV2(repo, plan) };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }) + '\n') };
  }
  // v0: wants (the first may carry capabilities) up to the first flush, then haves/done.
  const flushIndex = packets.findIndex((packet) => packet.kind === 'flush');
  const firstSection = flushIndex < 0 ? lines : packetLines(packets.slice(0, flushIndex));
  const secondSection = flushIndex < 0 ? [] : packetLines(packets.slice(flushIndex + 1));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of firstSection) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const line of secondSection) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  return { status: 200, contentType, body: fetchResponseV0(repo, plan) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** True when `descendant` has `ancestor` in its commit ancestry (or equals it). */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function handleReceivePack(repo: Repo, body: Buffer): HttpResult {
  const contentType = 'application/x-git-receive-pack-result';
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const line of packetLines(packets)) {
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates && rest.length > 0) {
    try {
      const read = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (hasUpdates && rest.length === 0) {
    // A command list that creates or updates a ref without a pack cannot unpack.
    unpackOk = false;
    unpackDetail = 'unpacker error: no packfile';
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old value mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} old value mismatch\n`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (target.type === 'commit' && !isDescendant(repo, command.newOid, current)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const inner = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines]);
  const banded = Buffer.concat([Buffer.from([1]), inner]);
  const parts: Buffer[] = [encodePktLine(banded), Buffer.from('0000', 'ascii')];
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// contents commits (used by REST): build a commit that writes one file path
// ---------------------------------------------------------------------------------------------

export interface ContentsCommit {
  commitSha: string;
  blobSha: string;
}

/** Write `content` at `path` on `branch`, returning the new commit and blob ids. */
export function commitContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  authorLogin: string,
): ContentsCommit {
  const blobSha = hashObject('blob', content);
  if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
  const refName = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(refName);
  const parent = parentOid !== undefined ? repo.objects.get(parentOid) : undefined;
  const parentTreeOid = parent !== undefined && parent.type === 'commit' ? parseCommit(parent.data).tree : undefined;

  // Rebuild the tree path from the root, replacing the file at its leaf.
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const buildLevel = (treeOid: string | undefined, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== undefined) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject && treeObject.type === 'tree') {
        for (const entry of parseTree(treeObject.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth];
    if (depth === segments.length - 1) {
      entries.set(name, { mode: '100644', name, oid: blobSha });
    } else {
      const child = entries.get(name);
      const childOid = buildLevel(child?.mode === '40000' ? child.oid : undefined, depth + 1);
      entries.set(name, { mode: '40000', name, oid: childOid });
    }
    const treeData = buildTree([...entries.values()]);
    const treeSha = hashObject('tree', treeData);
    if (!repo.objects.has(treeSha)) repo.objects.set(treeSha, { type: 'tree', data: treeData });
    return treeSha;
  };
  const treeSha = buildLevel(parentTreeOid, 0);
  const epochSec = Math.floor(Date.now() / 1000);
  const identity = `${authorLogin} <${authorLogin}@example.invalid> ${epochSec} +0000`;
  const commitData = buildCommit({
    tree: treeSha,
    parents: parentOid !== undefined ? [parentOid] : [],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = hashObject('commit', commitData);
  if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
  repo.refs.set(refName, commitSha);
  return { commitSha, blobSha };
}

/** Read a path from a branch tip's tree: the blob, or the directory's entries. */
export function readContentsPath(
  repo: Repo,
  branch: string,
  path: string,
): { kind: 'file'; blob: GitObject; oid: string } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const commitObject = repo.objects.get(tip);
  if (!commitObject || commitObject.type !== 'commit') return null;
  let treeOid = parseCommit(commitObject.data).tree;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject) return null;
    return { kind: 'dir', entries: parseTree(treeObject.data) };
  }
  for (let index = 0; index < segments.length; index += 1) {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      const object = repo.objects.get(entry.oid);
      if (!object) return null;
      if (object.type === 'blob') return { kind: 'file', blob: object, oid: entry.oid };
      if (object.type === 'tree') return { kind: 'dir', entries: parseTree(object.data) };
      return null;
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

export type { GitObjectType };
