/**
 * Verify Leap360 Authority Receipts offline (issue #29).
 *
 *   import { verifyReceipts } from 'leap360/receipts';
 *   const report = verifyReceipts(receipts, publicKeyPem);   // public key: GET /v1/receipts/public-key
 *
 * Checks, for every receipt: the Ed25519 signature over its canonical JSON, and that its hash is what it claims.
 * Then, per agent: receipts form one unbroken chain (each `prev` is the hash of the one before, `seq` has no gaps).
 * A receipt that was edited, removed or inserted shows up as a failure. Node.js only (uses node:crypto).
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

export interface AuthorityReceipt {
  v: 1;
  id: string;
  kind: 'decision' | 'approval';
  agent: string | null;
  tool: string;
  argsHash: string;
  verdict: string;
  enforced: string;
  policy: { id?: string; name: string } | null;
  at: string;
  seq: number;
  prev: string | null;
  [k: string]: unknown;
}

export interface SignedReceipt { receipt: AuthorityReceipt; hash: string; signature: string; keyId: string; alg: 'Ed25519' }

export interface VerifyReport {
  ok: boolean;
  checked: number;
  agents: number;
  problems: { id: string; agent: string | null; seq?: number; problem: string }[];
}

/** The same canonical JSON the API signs: keys sorted, no undefined values */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function verifyReceipts(receipts: SignedReceipt[], publicKeyPem: string, opts: { fromStart?: boolean } = {}): VerifyReport {
  const key = createPublicKey(publicKeyPem);
  const problems: VerifyReport['problems'] = [];
  const valid: SignedReceipt[] = [];
  // The same receipt can be exported twice (for example from a risky action's backup copy): count it once
  const seen = new Set<string>();
  for (const r of receipts) {
    if (r?.hash && seen.has(r.hash)) continue;
    if (r?.hash) seen.add(r.hash);
    const id = r?.receipt?.id ?? '(no id)';
    const agent = r?.receipt?.agent ?? null;
    if (!r?.receipt || !r.signature) { problems.push({ id, agent, problem: 'no receipt or signature' }); continue; }
    const text = canonical(r.receipt);
    if (sha256(text) !== r.hash) { problems.push({ id, agent, seq: r.receipt.seq, problem: 'contents do not match the hash: edited after signing' }); continue; }
    if (!verify(null, Buffer.from(text), key, Buffer.from(r.signature, 'base64'))) { problems.push({ id, agent, seq: r.receipt.seq, problem: 'signature does not verify with this public key' }); continue; }
    valid.push(r);
  }
  // Per agent: one chain, no gaps, each link pointing at the previous receipt
  const byAgent = new Map<string, SignedReceipt[]>();
  for (const r of valid) {
    const k = r.receipt.agent ?? '(no agent)';
    byAgent.set(k, [...(byAgent.get(k) ?? []), r]);
  }
  for (const [agent, list] of byAgent) {
    list.sort((a, b) => a.receipt.seq - b.receipt.seq);
    list.forEach((r, i) => {
      if (i === 0) {
        if (opts.fromStart && (r.receipt.seq !== 1 || r.receipt.prev !== null)) problems.push({ id: r.receipt.id, agent, seq: r.receipt.seq, problem: 'the chain does not start at the first receipt' });
        return;
      }
      const before = list[i - 1];
      if (r.receipt.seq !== before.receipt.seq + 1) problems.push({ id: r.receipt.id, agent, seq: r.receipt.seq, problem: `receipt ${before.receipt.seq + 1} is missing` });
      else if (r.receipt.prev !== before.hash) problems.push({ id: r.receipt.id, agent, seq: r.receipt.seq, problem: 'does not link to the previous receipt' });
    });
  }
  return { ok: problems.length === 0, checked: receipts.length, agents: byAgent.size, problems };
}
