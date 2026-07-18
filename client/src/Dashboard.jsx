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

function Sparkline({ trend }) {
  if (!trend || trend.length === 0) return <div className="w-20 h-6 shrink-0" />;
  const w = 80, h = 24, pad = 2;
  const values = trend.map(m => m.adjusted_net_profit);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const xFor = (i) => pad + (i / Math.max(1, trend.length - 1)) * (w - pad * 2);
  const yFor = (v) => pad + (1 - (v - min) / range) * (h - pad * 2);
  const points = trend.map((m, i) => `${xFor(i)},${yFor(m.adjusted_net_profit)}`).join(' ');
  const last = values[values.length - 1] || 0;
  const color = last >= 0 ? '#16a34a' : '#dc2626';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-20 h-6 shrink-0" title="Last 12 months profit trend">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export default function Dashboard({ apiBase, authHeaders, onGoToReporting, onGoToMatching }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hoverPoint, setHoverPoint] = useState(null); // { index, x, y }
  const [monthDetail, setMonthDetail] = useState(null); // clicked month's by_store data
  const [businesses, setBusinesses] = useState([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState('');

  const loadBusinesses = async () => {
    try {
      const res = await fetch(`${apiBase}/businesses`, { headers: authHeaders() });
      const json = await res.json();
      setBusinesses(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error('Error loading businesses:', err);
    }
  };

  const load = async (businessId) => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (businessId) params.append('business_id', businessId);
      const res = await fetch(`${apiBase}/reporting/dashboard?${params.toString()}`, { headers: authHeaders() });
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

  useEffect(() => { loadBusinesses(); }, []);
  useEffect(() => { load(selectedBusinessId); }, [selectedBusinessId]);

  if (loading && !data) return <div className="text-center text-gray-400 py-10 text-sm">Loading dashboard...</div>;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-4">
        {error}
        <button onClick={() => load(selectedBusinessId)} className="ml-3 underline font-semibold">Retry</button>
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
  const expenseLinePoints = trend.map((m, i) => `${xFor(i)},${yFor(m.other_expenses)}`).join(' ');

  return (
    <div className="space-y-8">
      <div className="pb-4 border-b border-gray-100 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
          <p className="text-sm text-gray-500 mt-1">Business summary for {new Date().getFullYear()} year-to-date</p>
        </div>
        {businesses.length > 0 && (
          <div className="flex items-center gap-2">
            {loading && <span className="text-xs text-gray-400">Loading...</span>}
            <select
              value={selectedBusinessId}
              onChange={e => setSelectedBusinessId(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Businesses</option>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
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
          <div className="relative">
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
              <polyline points={expenseLinePoints} fill="none" stroke="#f97316" strokeWidth="1.5" strokeDasharray="4 3" />
              {trend.map((m, i) => (
                <circle
                  key={m.month}
                  cx={xFor(i)}
                  cy={yFor(m.adjusted_net_profit)}
                  r={hoverPoint?.index === i ? 5 : 3}
                  fill="#2563eb"
                  className="transition-all"
                />
              ))}
              {trend.map((m, i) => (
                <text key={m.month} x={xFor(i)} y={chartH - 8} fontSize="9" textAnchor="middle" fill="#94a3b8">
                  {fmtMonthLabel(m.month)}
                </text>
              ))}
              {/* Invisible hit-areas: full-column hover + click, covers the whole month */}
              {trend.map((m, i) => (
                <rect
                  key={`hit-${m.month}`}
                  x={xFor(i) - (plotW / trend.length) / 2}
                  y={padT}
                  width={plotW / trend.length}
                  height={plotH}
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverPoint({ index: i, x: xFor(i), y: yFor(m.adjusted_net_profit) })}
                  onMouseLeave={() => setHoverPoint(null)}
                  onClick={() => setMonthDetail(m)}
                />
              ))}
            </svg>

            {hoverPoint !== null && trend[hoverPoint.index] && (
              <div
                className="absolute z-10 bg-gray-900 text-white text-xs rounded-md px-3 py-2 shadow-lg pointer-events-none space-y-0.5"
                style={{
                  left: `${(hoverPoint.x / chartW) * 100}%`,
                  top: `${(hoverPoint.y / chartH) * 100}%`,
                  transform: 'translate(-50%, -115%)',
                  whiteSpace: 'nowrap'
                }}
              >
                <div className="font-bold">{fmtMonthLabel(trend[hoverPoint.index].month)}</div>
                <div className="text-blue-300">Revenue: {fmtMoney(trend[hoverPoint.index].gross_revenue)}</div>
                <div className="text-green-300">Profit: {fmtMoney(trend[hoverPoint.index].adjusted_net_profit)}</div>
                <div className="text-orange-300">Expenses: {fmtMoney(trend[hoverPoint.index].other_expenses)}</div>
                <div className="text-gray-400 italic">Click for per-store breakdown</div>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-100 inline-block rounded-sm" /> Gross Revenue</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-600 inline-block rounded-full" /> Adjusted Net Profit</span>
          <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-orange-500 inline-block" style={{ borderTop: '1.5px dashed #f97316', background: 'none' }} /> Other Expenses</span>
        </div>
      </div>

      {/* Month drill-down modal (click on a chart point) */}
      {monthDetail && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" onClick={() => setMonthDetail(null)}>
          <div className="bg-white rounded-lg shadow-2xl p-5 max-w-md w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b pb-2 mb-3">
              <h3 className="font-bold text-gray-800">{fmtMonthLabel(monthDetail.month)} — Per-Store Profit</h3>
              <button onClick={() => setMonthDetail(null)} className="text-gray-400 hover:text-gray-700">&times;</button>
            </div>
            <div className="space-y-2">
              {(monthDetail.by_store || []).length === 0 && <div className="text-gray-400 text-sm text-center py-4">No store data for this month.</div>}
              {(monthDetail.by_store || [])
                .slice()
                .sort((a, b) => b.adjusted_net_profit - a.adjusted_net_profit)
                .map(s => (
                  <div key={s.store_id} className="flex items-center justify-between px-3 py-2 rounded border border-gray-100 text-sm">
                    <span className="font-medium text-gray-700">{s.store_name}</span>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-gray-500">Rev: {fmtMoney(s.gross_revenue)}</span>
                      <span className={`font-semibold ${s.adjusted_net_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>Profit: {fmtMoney(s.adjusted_net_profit)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}


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
                className="w-full text-left flex items-center justify-between px-3 py-2.5 rounded-md border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition gap-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Store size={16} className="text-gray-400 shrink-0" />
                  <span className="font-medium text-gray-800 text-sm truncate">{s.store_name}</span>
                </div>
                <Sparkline trend={s.trend} />
                <div className="flex items-center gap-4 text-xs shrink-0">
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
