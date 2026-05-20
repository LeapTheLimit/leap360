import { useEffect, useState, useCallback } from 'react';
import { Power, AlertTriangle, CheckCircle, RefreshCw, ShieldOff } from 'lucide-react';
import {
    fetchKillSwitch,
    fetchAgents,
    setGlobalKillSwitch,
    setAgentKillSwitch,
} from '../api';

interface AgentSwitch {
    agentName: string;
    status: 'ACTIVE' | 'SUSPENDED';
    reason: string | null;
    updatedAt: string | null;
}

interface KillSwitchState {
    global: {
        status: 'ACTIVE' | 'SUSPENDED';
        reason: string | null;
        updatedAt: string | null;
    };
    agents: AgentSwitch[];
}

interface Agent {
    name: string;
    status: string;
    model: string;
    calls: number;
}

export function KillSwitchView() {
    const [state, setState] = useState<KillSwitchState | null>(null);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [ks, ag] = await Promise.all([fetchKillSwitch(), fetchAgents()]);
            setState(ks);
            setAgents(ag);
        } catch (e: any) {
            setError('Failed to load kill-switch state: ' + (e?.message ?? e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const flash = (msg: string) => {
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(null), 3000);
    };

    const handleGlobal = async (status: 'ACTIVE' | 'SUSPENDED') => {
        setWorking(true);
        try {
            await setGlobalKillSwitch(status, reason || undefined);
            flash(`Global kill-switch → ${status}`);
            setReason('');
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        } finally {
            setWorking(false);
        }
    };

    const handleAgent = async (agentName: string, status: 'ACTIVE' | 'SUSPENDED') => {
        setWorking(true);
        try {
            await setAgentKillSwitch(agentName, status, reason || undefined);
            flash(`Agent "${agentName}" → ${status}`);
            await load();
        } catch (e: any) {
            setError(e?.message ?? String(e));
        } finally {
            setWorking(false);
        }
    };

    // Merge known agents from the fleet with kill-switch states
    const allAgentNames = Array.from(
        new Set([
            ...agents.map(a => a.name),
            ...(state?.agents.map(a => a.agentName) ?? []),
        ])
    );

    const getAgentStatus = (name: string): 'ACTIVE' | 'SUSPENDED' => {
        const sw = state?.agents.find(a => a.agentName === name);
        return (sw?.status as 'ACTIVE' | 'SUSPENDED') ?? 'ACTIVE';
    };

    const isGlobalSuspended = state?.global.status === 'SUSPENDED';

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <RefreshCw className="w-8 h-8 animate-spin text-blue-400" />
            </div>
        );
    }

    return (
        <div className="p-6 space-y-6 max-w-4xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <ShieldOff className="w-7 h-7 text-red-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-white">Kill Switch</h1>
                        <p className="text-sm text-gray-400">
                            Emergency stop controls — suspend all AI calls instantly.
                        </p>
                    </div>
                </div>
                <button
                    onClick={load}
                    className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                    title="Refresh"
                >
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            {/* Notifications */}
            {error && (
                <div className="bg-red-900/40 border border-red-500 rounded-lg p-3 text-red-300 text-sm flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    {error}
                    <button onClick={() => setError(null)} className="ml-auto">✕</button>
                </div>
            )}
            {successMsg && (
                <div className="bg-green-900/40 border border-green-500 rounded-lg p-3 text-green-300 text-sm flex gap-2">
                    <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    {successMsg}
                </div>
            )}

            {/* Reason input */}
            <div>
                <label className="block text-xs text-gray-400 mb-1">
                    Optional reason (shown in logs)
                </label>
                <input
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    placeholder="e.g. Security incident, maintenance…"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                />
            </div>

            {/* Global Kill Switch */}
            <div
                className={`rounded-xl border p-6 ${
                    isGlobalSuspended
                        ? 'border-red-500 bg-red-950/30'
                        : 'border-gray-700 bg-gray-800/50'
                }`}
            >
                <div className="flex items-center justify-between flex-wrap gap-4">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <Power
                                className={`w-5 h-5 ${
                                    isGlobalSuspended ? 'text-red-400' : 'text-green-400'
                                }`}
                            />
                            <span className="text-white font-semibold text-lg">
                                Global Kill Switch
                            </span>
                            <span
                                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                    isGlobalSuspended
                                        ? 'bg-red-500/20 text-red-300'
                                        : 'bg-green-500/20 text-green-300'
                                }`}
                            >
                                {state?.global.status ?? 'ACTIVE'}
                            </span>
                        </div>
                        <p className="text-sm text-gray-400">
                            Suspend <strong className="text-white">all</strong> AI calls
                            across the entire project immediately.
                        </p>
                        {state?.global.reason && (
                            <p className="text-xs text-gray-500 mt-1">
                                Reason: {state.global.reason}
                            </p>
                        )}
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={() => handleGlobal('SUSPENDED')}
                            disabled={working || isGlobalSuspended}
                            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            <Power className="w-4 h-4" />
                            Suspend All
                        </button>
                        <button
                            onClick={() => handleGlobal('ACTIVE')}
                            disabled={working || !isGlobalSuspended}
                            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                        >
                            <CheckCircle className="w-4 h-4" />
                            Resume All
                        </button>
                    </div>
                </div>
            </div>

            {/* Per-Agent Kill Switches */}
            <div>
                <h2 className="text-lg font-semibold text-white mb-3">Per-Agent Controls</h2>
                {allAgentNames.length === 0 ? (
                    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-8 text-center text-gray-500 text-sm">
                        No agents registered yet. Send a trace with an{' '}
                        <code className="text-gray-400">agent_name</code> to register one.
                    </div>
                ) : (
                    <div className="space-y-3">
                        {allAgentNames.map(agentName => {
                            const agentStatus = getAgentStatus(agentName);
                            const isSuspended = agentStatus === 'SUSPENDED';
                            const agentInfo = agents.find(a => a.name === agentName);

                            return (
                                <div
                                    key={agentName}
                                    className={`flex items-center justify-between p-4 rounded-xl border ${
                                        isSuspended
                                            ? 'border-red-500/50 bg-red-950/20'
                                            : 'border-gray-700 bg-gray-800/40'
                                    }`}
                                >
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-white font-medium">
                                                {agentName}
                                            </span>
                                            <span
                                                className={`text-xs px-2 py-0.5 rounded-full ${
                                                    isSuspended
                                                        ? 'bg-red-500/20 text-red-300'
                                                        : 'bg-green-500/20 text-green-300'
                                                }`}
                                            >
                                                {agentStatus}
                                            </span>
                                        </div>
                                        {agentInfo && (
                                            <p className="text-xs text-gray-500 mt-0.5">
                                                Model: {agentInfo.model} · Calls:{' '}
                                                {agentInfo.calls}
                                            </p>
                                        )}
                                    </div>

                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => handleAgent(agentName, 'SUSPENDED')}
                                            disabled={working || isSuspended}
                                            className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
                                        >
                                            Suspend
                                        </button>
                                        <button
                                            onClick={() => handleAgent(agentName, 'ACTIVE')}
                                            disabled={working || !isSuspended}
                                            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
                                        >
                                            Resume
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
