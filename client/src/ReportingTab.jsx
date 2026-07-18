import React, { useState, useEffect } from 'react';

export default function ReportingTab({ apiBase, authHeaders, stores, selectedStoreIds, selectedBusinessId }) {
  const [view, setView] = useState('pnl');
  const [year, setYear] = useState(new Date().getFullYear());
  const [storeId, setStoreId] = useState('');
  const [includeDisputed, setIncludeDisputed] = useState(false);
  const [pnl, setPnl] = useState(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [statement, setStatement] = useState(null);
  const [drillDown, setDrillDown] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadPnl = async () => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({ year, include_disputed: includeDisputed });
      if (storeId) params.append('store_id', storeId);
      const res = await fetch(`${apiBase}/reporting/monthly-pnl?${params.toString()}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load Monthly P&L');
        setPnl(null);
        return;
      }
      setPnl(data);
    } catch (err) {
      console.error('Error loading P&L:', err);
      setError('Failed to load Monthly P&L. Please try again.');
      setPnl(null);
    } finally {
      setLoading(false);
    }
  };

  const loadStatement = async () => {
    if (!storeId) { setStatement(null); return; }
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({ store_id: storeId, month, include_disputed: includeDisputed });
      const res = await fetch(`${apiBase}/reporting/monthly-store-statement?${params.toString()}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load Store Statement');
        setStatement(null);
        return;
      }
      setStatement(data);
    } catch (err) {
      console.error('Error loading statement:', err);
      setError('Failed to load Store Statement. Please try again.');
      setStatement(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (view === 'pnl') loadPnl(); }, [view, year, storeId, includeDisputed]);
  useEffect(() => { if (view === 'statement') loadStatement(); }, [view, month, storeId, includeDisputed]);

  const rowLines = pnl ? [
    ['Gross Revenue', 'gross_revenue'], ['Platform Fees', 'platform_fees'], ['Ads Fees', 'ads_fees'],
    ['Shipping Cost', 'shipping_cost'], ['Other Fees', 'other_fees'], ['Refunds', 'refunds'],
    ['Platform Net Earnings', 'platform_net_earnings'], ['COGS (Goods Cost)', 'cogs'], ['Net Profit', 'net_profit'],
    ['Other Income', 'other_income'], ['Other Expenses', 'other_expenses'], ['Adjusted Net Profit', 'adjusted_net_profit']
  ] : [];

  const openDrill = async (monthKey, lineKey) => {
    // Simple drill-down: fetch the underlying market orders for that month/store and show a small table
    const params = new URLSearchParams({ store_id: storeId || '', date_from: `${monthKey}-01`, date_to: `${monthKey}-31` });
    const res = await fetch(`${apiBase}/market-orders?${params.toString()}`, { headers: authHeaders() });
    const data = await res.json();
    setDrillDown({ month: monthKey, line: lineKey, rows: data });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Reporting</h2>
        <div className="flex gap-2 text-sm">
          <button onClick={() => setView('pnl')} className={`px-3 py-1 rounded ${view === 'pnl' ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}>Monthly P&L</button>
          <button onClick={() => setView('statement')} className={`px-3 py-1 rounded ${view === 'statement' ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}>Store Statement</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Stores (Consolidated)</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {view === 'pnl' ? (
          <input type="number" value={year} onChange={e => setYear(e.target.value)} className="border border-gray-300 rounded px-2 py-1 w-24" />
        ) : (
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="border border-gray-300 rounded px-2 py-1" />
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={includeDisputed} onChange={e => setIncludeDisputed(e.target.checked)} className="rounded" />
          Include disputed orders
        </label>
        {pnl && <span className="text-gray-400">({pnl.excluded_count} orders currently excluded as disputed)</span>}
        {statement && <span className="text-gray-400">(dispute filter: {statement.include_disputed ? 'including' : 'excluding'} disputed)</span>}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3 mb-4">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-center text-gray-400 py-4 text-sm">Loading...</div>
      )}

      {view === 'pnl' && pnl && pnl.months && (
        <div className="overflow-x-auto border rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-bold text-gray-500 uppercase">Line</th>
                {pnl.months.map(m => <th key={m.month} className="px-3 py-2 text-right font-bold text-gray-500 uppercase">{m.month}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rowLines.map(([label, key]) => (
                <tr key={key} className={key === 'net_profit' || key === 'adjusted_net_profit' ? 'font-bold bg-gray-50' : ''}>
                  <td className="px-3 py-2">{label}</td>
                  {pnl.months.map(m => (
                    <td key={m.month} className="px-3 py-2 text-right">
                      <button onClick={() => openDrill(m.month, key)} className="hover:underline hover:text-emerald-600">
                        ${Number(m[key]).toFixed(2)}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
              {pnl.months.length === 0 && <tr><td colSpan={2} className="px-3 py-6 text-center text-gray-400">No data for this year.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'statement' && (
        !storeId ? (
          <div className="text-center text-gray-400 py-8">Select a single store to view its Monthly Store Statement.</div>
        ) : statement && statement.rows && (
          <div className="overflow-x-auto border rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>{['Date','Market Order ID','Item','Total Price','Earnings','COGS','Status','Dispute','Net Profit','Comments'].map(h => <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {statement.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">{r.order_date}</td>
                    <td className="px-3 py-2 font-mono">{r.market_order_id}</td>
                    <td className="px-3 py-2 max-w-[140px] truncate">{r.item_title}</td>
                    <td className="px-3 py-2">${Number(r.total_price || 0).toFixed(2)}</td>
                    <td className="px-3 py-2">${Number(r.order_earnings || 0).toFixed(2)}</td>
                    <td className="px-3 py-2">${Number(r.cogs || 0).toFixed(2)}</td>
                    <td className="px-3 py-2">{r.order_status}</td>
                    <td className="px-3 py-2">{r.dispute_status}</td>
                    <td className="px-3 py-2">${Number(r.net_profit || 0).toFixed(2)}</td>
                    <td className="px-3 py-2 max-w-[140px] truncate">{r.comments}</td>
                  </tr>
                ))}
                {statement.rows.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-400">No orders for this month.</td></tr>
                )}
              </tbody>
              <tfoot className="bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2" colSpan={3}>Totals ({statement.totals?.total_orders || 0} orders)</td>
                  <td className="px-3 py-2">${Number(statement.totals?.total_price || 0).toFixed(2)}</td>
                  <td className="px-3 py-2">${Number(statement.totals?.total_earnings || 0).toFixed(2)}</td>
                  <td className="px-3 py-2">${Number(statement.totals?.total_cogs || 0).toFixed(2)}</td>
                  <td className="px-3 py-2" colSpan={2}></td>
                  <td className="px-3 py-2">${Number(statement.totals?.total_net_profit || 0).toFixed(2)}</td>
                  <td className="px-3 py-2"></td>
                </tr>
                <tr>
                  <td className="px-3 py-2" colSpan={10}>Gross Margin: {Number(statement.totals?.gross_margin || 0).toFixed(1)}% &nbsp; | &nbsp; Net Margin: {Number(statement.totals?.net_margin || 0).toFixed(1)}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      )}

      {drillDown && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-3xl w-full max-h-[80vh] overflow-y-auto space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold">Underlying Orders — {drillDown.month} / {drillDown.line}</h3>
              <button onClick={() => setDrillDown(null)}>&times;</button>
            </div>
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">Order ID</th><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Gross</th><th className="px-2 py-1 text-left">Net Earnings</th></tr></thead>
              <tbody>
                {drillDown.rows.map(r => (
                  <tr key={r.id} className="border-t"><td className="px-2 py-1 font-mono">{r.market_order_id}</td><td className="px-2 py-1">{r.order_date}</td><td className="px-2 py-1">${Number(r.gross_amount).toFixed(2)}</td><td className="px-2 py-1">${Number(r.net_earnings).toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
