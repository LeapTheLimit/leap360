import React, { useEffect, useState, useCallback } from 'react';
import { Shield, Plus, Trash2, RefreshCw, ToggleLeft, ToggleRight, Edit2 } from 'lucide-react';
import { fetchPolicies, createPolicy, updatePolicy, deletePolicy } from '../api';

interface Policy {
    id: string;
    name: string;
    description: string | null;
    severity: 'low' | 'medium' | 'high' | 'critical';
    action: 'log' | 'block';
    enabled: boolean;
    rules: string[];
    violationCount: number;
    createdAt: string;
}

const SEV_BADGE: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-300',
    high: 'bg-orange-500/20 text-orange-300',
    medium: 'bg-yellow-500/20 text-yellow-300',
    low: 'bg-blue-500/20 text-blue-300',
};

const EMPTY_FORM = {
    name: '',
    description: '',
    severity: 'medium' as Policy['severity'],
    action: 'log' as Policy['action'],
    enabled: true,
    rules: '',
};

export function PoliciesView() {
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editing, setEditing] = useState<Policy | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setPolicies(await fetchPolicies());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const openNew = () => {
        setEditing(null);
        setForm(EMPTY_FORM);
        setShowForm(true);
    };

    const openEdit = (p: Policy) => {
        setEditing(p);
        setForm({
            name: p.name,
            description: p.description ?? '',
            severity: p.severity,
            action: p.action,
            enabled: p.enabled,
            rules: p.rules.join('\n'),
        });
        setShowForm(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setWorking(true);
        setError(null);
        try {
            const payload = {
                name: form.name,
                description: form.description || undefined,
                severity: form.severity,
                action: form.action,
                enabled: form.enabled,
                rules: form.rules.split('\n').map(r => r.trim()).filter(Boolean),
            };
            if (editing) {
                await updatePolicy(editing.id, payload);
            } else {
                await createPolicy(payload);
            }
            setShowForm(false);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        } finally {
            setWorking(false);
        }
    };

    const handleToggle = async (p: Policy) => {
        try {
            await updatePolicy(p.id, { enabled: !p.enabled });
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        }
    };

    const handleDelete = async (p: Policy) => {
        if (!confirm(`Delete policy "${p.name}"?`)) return;
        try {
            await deletePolicy(p.id);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        }
    };

    return (
        <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                    <Shield className="w-7 h-7 text-blue-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-white">Policies & Rules</h1>
                        <p className="text-sm text-gray-400">
                            Governance policy definitions and rule management.
                        </p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={load}
                        className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={openNew}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                        New Policy
                    </button>
                </div>
            </div>

            {error && (
                <div className="bg-red-900/40 border border-red-500 rounded-lg p-3 text-red-300 text-sm flex gap-2">
                    {error}
                    <button onClick={() => setError(null)} className="ml-auto">✕</button>
                </div>
            )}

            {/* Policy Form Modal */}
            {showForm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-4">
                        <h2 className="text-lg font-semibold text-white">
                            {editing ? 'Edit Policy' : 'New Policy'}
                        </h2>
                        <form onSubmit={handleSubmit} className="space-y-3">
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">Name *</label>
                                <input
                                    required
                                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                                    value={form.name}
                                    onChange={e => setForm({ ...form, name: e.target.value })}
                                    placeholder="e.g. PII Protection"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">Description</label>
                                <input
                                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                                    value={form.description}
                                    onChange={e => setForm({ ...form, description: e.target.value })}
                                    placeholder="What this policy checks…"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-gray-400 mb-1 block">Severity</label>
                                    <select
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                                        value={form.severity}
                                        onChange={e => setForm({ ...form, severity: e.target.value as Policy['severity'] })}
                                    >
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                        <option value="critical">Critical</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-gray-400 mb-1 block">Action</label>
                                    <select
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                                        value={form.action}
                                        onChange={e => setForm({ ...form, action: e.target.value as Policy['action'] })}
                                    >
                                        <option value="log">Log only</option>
                                        <option value="block">Block</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">
                                    Rules (one per line)
                                </label>
                                <textarea
                                    rows={3}
                                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                                    value={form.rules}
                                    onChange={e => setForm({ ...form, rules: e.target.value })}
                                    placeholder={"email\nphone number\nSSN"}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="enabled"
                                    checked={form.enabled}
                                    onChange={e => setForm({ ...form, enabled: e.target.checked })}
                                    className="accent-blue-500"
                                />
                                <label htmlFor="enabled" className="text-sm text-gray-300">
                                    Enabled
                                </label>
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowForm(false)}
                                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={working}
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
                                >
                                    {working ? 'Saving…' : editing ? 'Update' : 'Create'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Policies list */}
            {loading ? (
                <div className="flex justify-center py-12">
                    <RefreshCw className="w-6 h-6 animate-spin text-blue-400" />
                </div>
            ) : policies.length === 0 ? (
                <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-12 text-center text-gray-500 text-sm">
                    <Shield className="w-10 h-10 mx-auto mb-3 text-gray-600" />
                    No policies yet. Click "New Policy" to add one.
                </div>
            ) : (
                <div className="space-y-3">
                    {policies.map(p => (
                        <div
                            key={p.id}
                            className={`flex items-start justify-between p-5 rounded-xl border transition-colors ${
                                p.enabled
                                    ? 'border-gray-700 bg-gray-800/40'
                                    : 'border-gray-700/50 bg-gray-800/20 opacity-60'
                            }`}
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center flex-wrap gap-2 mb-1">
                                    <span className="text-white font-medium">{p.name}</span>
                                    <span className={`text-xs px-2 py-0.5 rounded-full ${SEV_BADGE[p.severity]}`}>
                                        {p.severity}
                                    </span>
                                    <span
                                        className={`text-xs px-2 py-0.5 rounded-full ${
                                            p.action === 'block'
                                                ? 'bg-red-500/20 text-red-300'
                                                : 'bg-gray-500/20 text-gray-300'
                                        }`}
                                    >
                                        {p.action}
                                    </span>
                                    {p.violationCount > 0 && (
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300">
                                            {p.violationCount} violation{p.violationCount !== 1 ? 's' : ''}
                                        </span>
                                    )}
                                </div>
                                {p.description && (
                                    <p className="text-sm text-gray-400 mb-2">{p.description}</p>
                                )}
                                {p.rules.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {p.rules.map((r, i) => (
                                            <span
                                                key={i}
                                                className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded font-mono"
                                            >
                                                {r}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex items-center gap-2 ml-4 shrink-0">
                                <button
                                    onClick={() => handleToggle(p)}
                                    title={p.enabled ? 'Disable' : 'Enable'}
                                    className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                                >
                                    {p.enabled ? (
                                        <ToggleRight className="w-5 h-5 text-green-400" />
                                    ) : (
                                        <ToggleLeft className="w-5 h-5" />
                                    )}
                                </button>
                                <button
                                    onClick={() => openEdit(p)}
                                    title="Edit"
                                    className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                                >
                                    <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => handleDelete(p)}
                                    title="Delete"
                                    className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
