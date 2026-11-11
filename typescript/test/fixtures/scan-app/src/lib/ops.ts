import { rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';

export async function wipeCache() {
  await rm('/var/cache/app', { recursive: true, force: true });
  execSync('kubectl delete pods --all -n cache --context prod');
}
