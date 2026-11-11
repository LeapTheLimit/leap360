import * as k8s from '@kubernetes/client-node';

const api = new k8s.KubeConfig().makeApiClient(k8s.CoreV1Api);

export async function removeNamespace(name: string) {
  return deleteNs(name);
}

function deleteNs(name: string) {
  return api.deleteNamespace({ name });
}
