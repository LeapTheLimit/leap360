import axios from 'axios';

// When running via Vite dev server the proxy forwards /v1 → localhost:4000
// In production builds set VITE_API_BASE_URL to wherever the API is hosted.
const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || '',
});

export const PROJECT_ID =
    import.meta.env.VITE_PROJECT_ID || '00000000-0000-0000-0000-000000000001';

// ── Services ──────────────────────────────────────────────────────────────────
export const fetchServices = () =>
    api.get(`/v1/projects/${PROJECT_ID}/services`).then(r => r.data);

// ── Traces ────────────────────────────────────────────────────────────────────
export const fetchTraces = (serviceId?: string, agentName?: string) => {
    const params: Record<string, string> = {};
    if (serviceId) params.service = serviceId;
    if (agentName) params.agent = agentName;
    return api.get(`/v1/projects/${PROJECT_ID}/traces`, { params }).then(r => r.data);
};

export const fetchTrace = (id: string) =>
    api.get(`/v1/traces/${id}`).then(r => r.data);

// ── Stats ─────────────────────────────────────────────────────────────────────
export const fetchStats = () =>
    api.get(`/v1/projects/${PROJECT_ID}/stats`).then(r => r.data);

// ── Agents ────────────────────────────────────────────────────────────────────
export const fetchAgents = () =>
    api.get(`/v1/projects/${PROJECT_ID}/agents`).then(r => r.data);

// ── Models ────────────────────────────────────────────────────────────────────
export const fetchModels = () =>
    api.get(`/v1/projects/${PROJECT_ID}/models`).then(r => r.data);

// ── Audit ─────────────────────────────────────────────────────────────────────
export const fetchAudit = () =>
    api.get(`/v1/projects/${PROJECT_ID}/audit`).then(r => r.data);

// ── Violations ────────────────────────────────────────────────────────────────
export const fetchViolations = (status?: string) => {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    return api.get(`/v1/projects/${PROJECT_ID}/violations`, { params }).then(r => r.data);
};

export const updateViolationStatus = (
    violationId: string,
    status: 'open' | 'investigating' | 'resolved'
) =>
    api
        .patch(`/v1/projects/${PROJECT_ID}/violations/${violationId}`, { status })
        .then(r => r.data);

// ── Policies ──────────────────────────────────────────────────────────────────
export const fetchPolicies = () =>
    api.get(`/v1/projects/${PROJECT_ID}/policies`).then(r => r.data);

export const createPolicy = (data: {
    name: string;
    description?: string;
    severity: string;
    action: string;
    enabled: boolean;
    rules: string[];
}) => api.post(`/v1/projects/${PROJECT_ID}/policies`, data).then(r => r.data);

export const updatePolicy = (
    policyId: string,
    data: Partial<{ name: string; description: string; severity: string; action: string; enabled: boolean; rules: string[] }>
) => api.put(`/v1/projects/${PROJECT_ID}/policies/${policyId}`, data).then(r => r.data);

export const deletePolicy = (policyId: string) =>
    api.delete(`/v1/projects/${PROJECT_ID}/policies/${policyId}`).then(r => r.data);

// ── Kill Switch ───────────────────────────────────────────────────────────────
export const fetchKillSwitch = () =>
    api.get(`/v1/projects/${PROJECT_ID}/killswitch`).then(r => r.data);

export const setGlobalKillSwitch = (status: 'ACTIVE' | 'SUSPENDED', reason?: string) =>
    api
        .post(`/v1/projects/${PROJECT_ID}/killswitch`, { status, reason })
        .then(r => r.data);

export const setAgentKillSwitch = (
    agentName: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason?: string
) =>
    api
        .post(`/v1/projects/${PROJECT_ID}/killswitch/agents/${encodeURIComponent(agentName)}`, {
            status,
            reason,
        })
        .then(r => r.data);
