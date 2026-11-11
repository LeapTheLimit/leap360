/**
 * Checks a `git push` before it leaves the machine (issue #10).
 *
 * `leap360 hook install` adds a git pre-push hook that runs `leap360 push-check`. For each branch being pushed it sends
 * Leap360 what the push does, never the code:
 *   - the repository (host/owner/name from the remote URL, without credentials) and the branch
 *   - how many commits, and the paths of changed files with how each changed (added, modified, deleted, renamed)
 *   - whether it is a force push
 *   - who is pushing: an AI coding agent (detected from its environment variables), CI, or a person
 * The push is checked like any other tool call ("push_code", or "force_push"), so shadow mode, policies, approvals and
 * the kill switch all apply. In enforce mode a blocked or held push stops with a message and git does not push.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Governor } from './governor.js';

const ZERO = /^0+$/;
const MAX_FILES = 300;

export interface PushRef { localRef: string; localSha: string; remoteRef: string; remoteSha: string }
export interface PushSummary {
  repo: string; branch: string; remoteRef: string; commits: number; force: boolean; deleted: boolean;
  files: { path: string; change: string }[]; filesTotal: number; agent: string;
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Who is pushing, from environment variables the common AI coding agents and CI systems set */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LEAP360_AGENT) return env.LEAP360_AGENT;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return 'cursor';
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return 'codex';
  if (env.WINDSURF_SESSION || env.CODEIUM_API_KEY) return 'windsurf';
  if (env.GITHUB_ACTIONS) return 'github-actions';
  if (env.CI) return 'ci';
  return 'human';
}

/** owner/name (with the host when it isn't GitHub), never the credentials some remote URLs carry */
export function repoName(remoteUrl: string): string {
  const u = remoteUrl.trim().replace(/\.git$/, '');
  // A remote on this machine (C:\repos\app.git, /srv/app.git, ../app.git, file://): its folder name only
  if (/^(?:[a-z]:[\\/]|[\\/]|\.{1,2}[\\/]|file:\/\/)/i.test(u)) return `local/${u.split(/[\\/]/).filter(Boolean).pop() ?? 'repository'}`;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i.exec(u);
  if (!m) return 'unknown';
  const [, host, rest] = m;
  return host === 'github.com' ? rest : `${host}/${rest}`;
}

/** Parses the lines git passes to a pre-push hook on stdin */
export function parsePushRefs(stdin: string): PushRef[] {
  const sha = /^[0-9a-f]{7,64}$/i;
  return stdin.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4 && sha.test(p[1]) && sha.test(p[3])).map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

export function summarizePush(cwd: string, remoteUrl: string, ref: PushRef, env: NodeJS.ProcessEnv = process.env): PushSummary {
  const deleted = ZERO.test(ref.localSha);
  const isNew = ZERO.test(ref.remoteSha);
  let commits = 0, force = false;
  let files: { path: string; change: string }[] = [];
  if (!deleted) {
    // A new branch: what is not on the remote yet. An existing one: what lies between the remote and the local tip.
    const range = isNew ? [ref.localSha, '--not', '--remotes'] : [`${ref.remoteSha}..${ref.localSha}`];
    try { commits = Number(git(cwd, ['rev-list', '--count', ...range])) || 0; } catch { commits = 0; }
    if (!isNew) {
      try { git(cwd, ['merge-base', '--is-ancestor', ref.remoteSha, ref.localSha]); } catch { force = true; }
    }
    try {
      const base = isNew ? (() => { try { return git(cwd, ['merge-base', ref.localSha, 'HEAD@{upstream}']); } catch { return ''; } })() : ref.remoteSha;
      const out = base ? git(cwd, ['diff', '--name-status', '-M', `${base}..${ref.localSha}`]) : git(cwd, ['show', '--name-status', '--format=', ref.localSha]);
      const CHANGE: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
      files = out.split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return { path: p[p.length - 1] ?? '', change: CHANGE[s[0]] ?? s }; });
    } catch { files = []; }
  }
  return {
    repo: repoName(remoteUrl), branch: ref.remoteRef.replace(/^refs\/heads\//, ''), remoteRef: ref.remoteRef,
    commits, force, deleted, files: files.slice(0, MAX_FILES), filesTotal: files.length, agent: detectAgent(env),
  };
}

/** The tool call Leap360 checks for one pushed branch */
export function pushAction(s: PushSummary) {
  return {
    name: s.deleted ? 'delete_branch' : s.force ? 'force_push' : 'push_code',
    args: { repo: s.repo, branch: s.branch, commits: s.commits, force: s.force, files: s.files.map((f) => `${f.change} ${f.path}`), filesTotal: s.filesTotal },
  };
}

/** The exit code that means "Leap360 stopped this push". Any other failure lets the push go ahead with a warning. */
export const BLOCKED_EXIT = 3;

/** Runs the check for every ref git is pushing. Returns the exit code for the hook: 0 to push, BLOCKED_EXIT to stop. */
export async function pushCheck(opts: { cwd: string; remoteUrl: string; stdin: string; apiKey: string; baseUrl?: string; dryRun?: boolean; log?: (m: string) => void }): Promise<number> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const refs = parsePushRefs(opts.stdin);
  if (!refs.length) return 0;
  const summaries = refs.map((r) => summarizePush(opts.cwd, opts.remoteUrl, r));
  if (opts.dryRun) {
    log(JSON.stringify(summaries.map((s) => ({ agent: s.agent, tool: pushAction(s) })), null, 2));
    return 0;
  }
  let blocked = false;
  for (const s of summaries) {
    const gov = new Governor({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, agentName: s.agent, poll: false, log,
      // A push check sends the repository, branch and file paths (never contents) so a person can judge it:
      // developer metadata, not what end users write. LEAP360_CAPTURE=metadata sends keys and types only.
      capture: (process.env['LEAP360_CAPTURE'] as 'metadata' | 'redacted' | 'full' | undefined) || 'redacted' });
    const gate = await gov.check(pushAction(s), 'sdk');
    gov.stop();
    if (!gate.allowed) {
      blocked = true;
      log(`\n[Leap360] Push to ${s.repo} ${s.branch} stopped: ${gate.message || `held by "${gate.policy?.name ?? 'a policy'}"`}`);
      if (gate.verdict === 'review') log('[Leap360] A person can approve it in the console (Approvals); then push again.');
    } else if (gate.wouldBe && gate.wouldBe !== 'allow') {
      log(`[Leap360] Shadow mode: this push to ${s.branch} would be ${gate.wouldBe === 'review' ? 'held' : gate.wouldBe === 'block' ? 'blocked' : 'warned'}. It went ahead.`);
    }
  }
  return blocked ? BLOCKED_EXIT : 0;
}

const HOOK_MARK = '# leap360 push-check';

/** Adds the pre-push hook to this repository, keeping any hook already there */
export function installPushHook(cwd: string): { hookPath: string; changed: boolean } {
  const gitDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-dir']));
  const hooksDir = (() => { try { const p = git(cwd, ['config', '--get', 'core.hooksPath']); return p ? path.resolve(cwd, p) : path.join(gitDir, 'hooks'); } catch { return path.join(gitDir, 'hooks'); } })();
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-push');
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
  if (existing.includes(HOOK_MARK)) return { hookPath, changed: false };
  // git passes the remote name and URL as arguments and the refs on stdin; both are handed on unchanged
  // Exit 3 means Leap360 stopped the push. Anything else (leap360 not installed, no network) warns and pushes, so a
  // broken tool can never lock people out of their own repository.
  const block = [
    `${HOOK_MARK}: checks each push with Leap360 before it leaves this machine. Remove these lines to stop.`,
    'npx --no-install leap360 push-check "$1" "$2"',
    'leap360_status=$?',
    `if [ "$leap360_status" -eq ${BLOCKED_EXIT} ]; then exit 1; fi`,
    'if [ "$leap360_status" -ne 0 ]; then echo "[Leap360] the push check did not run (exit $leap360_status); pushing anyway" >&2; fi',
    '',
  ].join('\n');
  const next = existing ? `${existing.replace(/\s*$/, '\n')}\n${block}` : `#!/bin/sh\n${block}`;
  writeFileSync(hookPath, next);
  try { chmodSync(hookPath, 0o755); } catch { /* Windows: git runs hooks through sh anyway */ }
  return { hookPath, changed: true };
}
