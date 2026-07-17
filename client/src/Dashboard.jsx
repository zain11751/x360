import React, { useState, useEffect } from 'react';
import { DollarSign, TrendingUp, TrendingDown, ShoppingCart, AlertTriangle, Upload, Store } from 'lucide-react';

function fmtMoney(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

export default function Dashboard({ apiBase, authHeaders, onGoToReporting, onGoToMatching }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/reporting/dashboard`, { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to load dashboard');
        setData(null);
        return;
      }
      setData(json);
    } catch (err) {
      console.error('Error loading dashboard:', err);
      setError('Failed to load dashboard. Please try again.');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-center text-gray-400 py-10 text-sm">Loading dashboard...</div>;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-4">
        {error}
        <button onClick={load} className="ml-3 underline font-semibold">Retry</button>
      </div>
    );
  }

  if (!data) return null;

  const t = data.year_totals || { gross_revenue: 0, adjusted_net_profit: 0, other_expenses: 0, total_orders: 0 };
  const trend = data.trend || [];
  const stores = data.stores || [];
  const topItems = data.top_items || [];
  const recentImports = data.recent_imports || [];
  const unmatchedCount = data.unmatched_count || 0;
  const holdAmount = data.hold_amount || 0;
  const holdOrderCount = data.hold_order_count || 0;

  // Build a simple SVG combo chart (revenue bars + profit line) from trend data, no extra chart library needed.
  const chartW = 760, chartH = 220, padL = 50, padR = 20, padT = 16, padB = 28;
  const plotW = chartW - padL - padR, plotH = chartH - padT - padB;
  const maxVal = Math.max(1, ...trend.map(m => Math.max(m.gross_revenue, m.adjusted_net_profit, m.other_expenses)));
  const barW = trend.length > 0 ? (plotW / trend.length) * 0.5 : 0;
  const xFor = (i) => padL + (plotW / Math.max(1, trend.length)) * i + (plotW / Math.max(1, trend.length)) / 2;
  const yFor = (v) => padT + plotH - (Math.max(0, v) / maxVal) * plotH;

  const linePoints = trend.map((m, i) => `${xFor(i)},${yFor(m.adjusted_net_profit)}`).join(' ');

  return (
    <div className="space-y-8">
      <div className="pb-4 border-b border-gray-100">
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-sm text-gray-500 mt-1">Business summary for {new Date().getFullYear()} year-to-date</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-bold uppercase mb-2">
            <DollarSign size={14} /> Gross Revenue
          </div>
          <div className="text-2xl font-bold text-gray-900">{fmtMoney(t.gross_revenue)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-bold uppercase mb-2">
            <TrendingUp size={14} /> Adjusted Net Profit
          </div>
          <div className={`text-2xl font-bold ${t.adjusted_net_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmtMoney(t.adjusted_net_profit)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-bold uppercase mb-2">
            <TrendingDown size={14} /> Other Expenses
          </div>
          <div className="text-2xl font-bold text-gray-900">{fmtMoney(t.other_expenses)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center gap-2 text-gray-400 text-xs font-bold uppercase mb-2">
            <ShoppingCart size={14} /> Total Orders
          </div>
          <div className="text-2xl font-bold text-gray-900">{t.total_orders}</div>
        </div>
        <div className="bg-white border border-amber-200 rounded-lg p-4 shadow-sm">
          <div className="flex items-center gap-2 text-amber-500 text-xs font-bold uppercase mb-2">
            <AlertTriangle size={14} /> Amount on Hold (Disputed)
          </div>
          <div className="text-2xl font-bold text-amber-700">{fmtMoney(holdAmount)}</div>
          <div className="text-xs text-gray-400 mt-1">{holdOrderCount} order{holdOrderCount === 1 ? '' : 's'} disputed</div>
        </div>
      </div>

      {/* Unmatched alert */}
      {unmatchedCount > 0 && (
        <button
          onClick={onGoToMatching}
          className="w-full text-left bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3 flex items-center gap-2 hover:bg-amber-100 transition"
        >
          <AlertTriangle size={16} />
          <span><strong>{unmatchedCount}</strong> order match{unmatchedCount === 1 ? '' : 'es'} still need attention in Order Matching.</span>
        </button>
      )}

      {/* Trend chart */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Last 12 Months — Revenue vs Profit vs Expenses</h3>
        {trend.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">No data yet for the last 12 months.</div>
        ) : (
          <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-auto">
            {[0, 0.25, 0.5, 0.75, 1].map(f => (
              <line key={f} x1={padL} x2={chartW - padR} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="#f1f5f9" strokeWidth="1" />
            ))}
            {trend.map((m, i) => (
              <rect
                key={m.month}
                x={xFor(i) - barW / 2}
                y={yFor(m.gross_revenue)}
                width={barW}
                height={Math.max(0, yFor(0) - yFor(m.gross_revenue))}
                fill="#dbeafe"
              />
            ))}
            <polyline points={linePoints} fill="none" stroke="#2563eb" strokeWidth="2" />
            {trend.map((m, i) => (
              <circle key={m.month} cx={xFor(i)} cy={yFor(m.adjusted_net_profit)} r="3" fill="#2563eb" />
            ))}
            {trend.map((m, i) => (
              <text key={m.month} x={xFor(i)} y={chartH - 8} fontSize="9" textAnchor="middle" fill="#94a3b8">
                {fmtMonthLabel(m.month)}
              </text>
            ))}
          </svg>
        )}
        <div className="flex gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-100 inline-block rounded-sm" /> Gross Revenue</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-600 inline-block rounded-full" /> Adjusted Net Profit</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Per-store breakdown */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Per-Store Breakdown ({new Date().getFullYear()})</h3>
          <div className="space-y-2">
            {stores.length === 0 && <div className="text-gray-400 text-sm text-center py-6">No stores yet.</div>}
            {stores.map(s => (
              <button
                key={s.store_id}
                onClick={onGoToReporting}
                className="w-full text-left flex items-center justify-between px-3 py-2.5 rounded-md border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition"
              >
                <div className="flex items-center gap-2">
                  <Store size={16} className="text-gray-400" />
                  <span className="font-medium text-gray-800 text-sm">{s.store_name}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-gray-500">{s.order_count} orders</span>
                  <span className="text-gray-700 font-semibold">{fmtMoney(s.gross_revenue)}</span>
                  <span className={`font-semibold ${s.adjusted_net_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmtMoney(s.adjusted_net_profit)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Top-selling items + Recent imports */}
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Top-Selling Items ({new Date().getFullYear()})</h3>
            {topItems.length === 0 ? (
              <div className="text-gray-400 text-sm text-center py-4">No orders yet this year.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {topItems.map((it, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-gray-700 truncate max-w-[220px]">{it.item_title}</span>
                    <span className="text-gray-400 text-xs">{it.order_count} orders</span>
                    <span className="font-semibold text-gray-800">{fmtMoney(it.total_gross)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
            <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
              <Upload size={14} /> Recent Imports
            </h3>
            {recentImports.length === 0 ? (
              <div className="text-gray-400 text-sm text-center py-4">No imports yet.</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentImports.map(imp => (
                  <div key={imp.id} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0">
                      <div className="text-gray-700 truncate max-w-[180px]">{imp.file_name}</div>
                      <div className="text-xs text-gray-400">{imp.import_type} · {new Date(imp.started_at).toLocaleDateString()}</div>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                      imp.status === 'completed' ? 'bg-green-50 text-green-700' :
                      imp.status === 'completed_with_errors' ? 'bg-amber-50 text-amber-700' :
                      imp.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {imp.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
