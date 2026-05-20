import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, CheckCircle, Search, Filter } from 'lucide-react';
import { fetchViolations, updateViolationStatus } from '../api';

interface Violation {
    id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    status: 'open' | 'investigating' | 'resolved';
    policy: string;
    action: string;
    agent: string | null;
    model: string | null;
    provider: string | null;
    createdAt: string;
    resolvedAt: string | null;
}

interface ViolationsData {
    violations: Violation[];
    summary: {
        open: number;
        investigating: number;
        resolved: number;
        total: number;
    };
}

const SEV_COLORS: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-300 border-red-500/30',
    high: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    low: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
};

const STATUS_COLORS: Record<string, string> = {
    open: 'bg-red-500/20 text-red-300',
    investigating: 'bg-yellow-500/20 text-yellow-300',
    resolved: 'bg-green-500/20 text-green-300',
};

export function ViolationsView() {
    const [data, setData] = useState<ViolationsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<string>('');
    const [search, setSearch] = useState('');
    const [working, setWorking] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await fetchViolations(filter || undefined);
            setData(result);
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => { load(); }, [load]);

    const handleStatus = async (id: string, status: 'open' | 'investigating' | 'resolved') => {
        setWorking(id);
        try {
            await updateViolationStatus(id, status);
            await load();
        } finally {
            setWorking(null);
        }
    };

    const violations = (data?.violations ?? []).filter(v =>
        !search ||
        v.description.toLowerCase().includes(search.toLowerCase()) ||
        (v.agent ?? '').toLowerCase().includes(search.toLowerCase()) ||
        v.policy.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                    <AlertTriangle className="w-7 h-7 text-orange-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-white">Violations</h1>
                        <p className="text-sm text-gray-400">
                            Policy violation log with severity and status tracking.
                        </p>
                    </div>
                </div>
                <button
                    onClick={load}
                    className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Summary cards */}
            {data && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                        { label: 'Open', count: data.summary.open, color: 'text-red-400' },
                        { label: 'Investigating', count: data.summary.investigating, color: 'text-yellow-400' },
                        { label: 'Resolved', count: data.summary.resolved, color: 'text-green-400' },
                        { label: 'Total', count: data.summary.total, color: 'text-gray-300' },
                    ].map(c => (
                        <div
                            key={c.label}
                            className="bg-gray-800/60 border border-gray-700 rounded-xl p-4"
                        >
                            <p className="text-xs text-gray-400 mb-1">{c.label}</p>
                            <p className={`text-2xl font-bold ${c.color}`}>{c.count}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-3">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                    <input
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        placeholder="Search violations…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-gray-500" />
                    {(['', 'open', 'investigating', 'resolved'] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => setFilter(s)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                filter === s
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                            }`}
                        >
                            {s || 'All'}
                        </button>
                    ))}
                </div>
            </div>

            {/* Table */}
            <div className="bg-gray-800/40 border border-gray-700 rounded-xl overflow-hidden">
                {loading ? (
                    <div className="flex justify-center py-12">
                        <RefreshCw className="w-6 h-6 animate-spin text-blue-400" />
                    </div>
                ) : violations.length === 0 ? (
                    <div className="text-center py-12 text-gray-500 text-sm">
                        <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-600/50" />
                        No violations found.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-700 text-left text-xs text-gray-400">
                                    <th className="px-4 py-3">Severity</th>
                                    <th className="px-4 py-3">Description</th>
                                    <th className="px-4 py-3">Policy</th>
                                    <th className="px-4 py-3">Agent</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3">Time</th>
                                    <th className="px-4 py-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {violations.map(v => (
                                    <tr
                                        key={v.id}
                                        className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors"
                                    >
                                        <td className="px-4 py-3">
                                            <span
                                                className={`px-2 py-0.5 rounded-full text-xs border ${SEV_COLORS[v.severity] ?? SEV_COLORS.medium}`}
                                            >
                                                {v.severity}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-gray-300 max-w-xs truncate">
                                            {v.description}
                                        </td>
                                        <td className="px-4 py-3 text-gray-400">{v.policy}</td>
                                        <td className="px-4 py-3 text-gray-400">
                                            {v.agent ?? '—'}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[v.status]}`}
                                            >
                                                {v.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                                            {new Date(v.createdAt).toLocaleString()}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex gap-1">
                                                {v.status !== 'investigating' && (
                                                    <button
                                                        onClick={() => handleStatus(v.id, 'investigating')}
                                                        disabled={working === v.id}
                                                        className="px-2 py-1 bg-yellow-600/30 hover:bg-yellow-600/50 text-yellow-300 rounded text-xs transition-colors disabled:opacity-50"
                                                    >
                                                        Investigate
                                                    </button>
                                                )}
                                                {v.status !== 'resolved' && (
                                                    <button
                                                        onClick={() => handleStatus(v.id, 'resolved')}
                                                        disabled={working === v.id}
                                                        className="px-2 py-1 bg-green-600/30 hover:bg-green-600/50 text-green-300 rounded text-xs transition-colors disabled:opacity-50"
                                                    >
                                                        Resolve
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
