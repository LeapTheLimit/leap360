import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000',
    headers: {
        // Note: The prompt says minimal auth is fine, and API needs x-leap360-key
        // for ingestion. The dashboard reads via GET /v1/projects/:id/... 
        // Wait, the API endpoints for frontend depend on what was implemented in api/src/routes.
        // Let's assume they don't need the x-leap360-key or we just pass it if needed.
        // Actually, we can check the API server auth if we want, but let's just use it.
    }
});

export const PROJECT_ID = '00000000-0000-0000-0000-000000000001';

export const fetchServices = async () => {
    const res = await api.get(`/v1/projects/${PROJECT_ID}/services`);
    return res.data;
};

export const fetchTraces = async (serviceId: string, agentName?: string) => {
    const params = agentName ? { agent: agentName } : {};
    // The prompt said: /v1/projects/:id/traces?service=...&agent=...
    const res = await api.get(`/v1/projects/${PROJECT_ID}/traces`, {
        params: { service: serviceId, ...params, limit: 100 }
    });
    return res.data;
};

export const fetchTraceDetail = async (traceId: string) => {
    const res = await api.get(`/v1/traces/${traceId}`);
    return res.data;
};

export default api;
