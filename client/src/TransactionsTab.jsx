import React, { useState, useEffect } from 'react';

export default function TransactionsTab({ apiBase, authHeaders, stores }) {
  const [view, setView] = useState('list');
  const [rows, setRows] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [filters, setFilters] = useState({ store_id: '', date_from: '', date_to: '', transaction_type: '', payout_batch_id: '', market_order_id: '' });

  const loadList = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
    const res = await fetch(`${apiBase}/transactions?${params.toString()}`, { headers: authHeaders() });
    const data = await res.json();
    setRows(Array.isArray(data) ? data : []);
  };

  const loadPayouts = async () => {
    const params = new URLSearchParams();
    if (filters.store_id) params.append('store_id', filters.store_id);
    const res = await fetch(`${apiBase}/transactions/payouts?${params.toString()}`, { headers: authHeaders() });
    const data = await res.json();
    setPayouts(Array.isArray(data) ? data : []);
  };

  useEffect(() => { if (view === 'list') loadList(); else loadPayouts(); }, [filters, view]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Transactions</h2>
        <div className="flex gap-2 text-sm">
          <button onClick={() => setView('list')} className={`px-3 py-1 rounded ${view === 'list' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>List</button>
          <button onClick={() => setView('payouts')} className={`px-3 py-1 rounded ${view === 'payouts' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>Payout View</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={filters.store_id} onChange={e => setFilters({...filters, store_id: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Stores</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {view === 'list' && (
          <>
            <input type="date" value={filters.date_from} onChange={e => setFilters({...filters, date_from: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
            <input type="date" value={filters.date_to} onChange={e => setFilters({...filters, date_to: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
            <input value={filters.transaction_type} onChange={e => setFilters({...filters, transaction_type: e.target.value})} placeholder="Type" className="border border-gray-300 rounded px-2 py-1" />
            <input value={filters.payout_batch_id} onChange={e => setFilters({...filters, payout_batch_id: e.target.value})} placeholder="Payout Batch ID" className="border border-gray-300 rounded px-2 py-1" />
            <input value={filters.market_order_id} onChange={e => setFilters({...filters, market_order_id: e.target.value})} placeholder="Search Market Order ID" className="border border-gray-300 rounded px-2 py-1" />
          </>
        )}
      </div>

      {view === 'list' ? (
        <div className="overflow-x-auto border border-gray-200 rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                {['Date', 'Type', 'Market Order ID', 'Net Amount', 'Gross Amount', 'Payout Batch', 'Payout Date', 'Payout Status'].map(h => (
                  <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">{r.transaction_date}</td>
                  <td className="px-3 py-2">{r.transaction_type}</td>
                  <td className="px-3 py-2 font-mono">{r.market_order_id}</td>
                  <td className="px-3 py-2">{r.net_amount !== null ? `$${Number(r.net_amount).toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-2">{r.gross_transaction_amount !== null ? `$${Number(r.gross_transaction_amount).toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-2">{r.payout_batch_id}</td>
                  <td className="px-3 py-2">{r.payout_date}</td>
                  <td className="px-3 py-2">{r.payout_status}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No transactions found.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3">
          {payouts.map((p, idx) => (
            <div key={idx} className="border rounded p-3">
              <div className="flex justify-between text-sm font-bold mb-2">
                <span>Batch: {p.payout_batch_id || '(no batch)'}</span>
                <span>{p.payout_date} — {p.payout_status}</span>
              </div>
              <table className="min-w-full text-xs">
                <tbody>
                  {p.transactions.map(t => (
                    <tr key={t.id} className="border-t">
                      <td className="px-2 py-1">{t.transaction_date}</td>
                      <td className="px-2 py-1">{t.transaction_type}</td>
                      <td className="px-2 py-1 font-mono">{t.market_order_id}</td>
                      <td className="px-2 py-1">{t.net_amount !== null ? `$${Number(t.net_amount).toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {payouts.length === 0 && <div className="text-center text-gray-400 py-8">No payouts found.</div>}
        </div>
      )}
    </div>
  );
}
