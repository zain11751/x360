import React, { useState, useEffect } from 'react';
import { Plus, X, Edit2, AlertTriangle } from 'lucide-react';

export default function MarketOrders({ apiBase, authHeaders, stores, customOptions, canEdit, onGoToOrderMatching }) {
  const [orders, setOrders] = useState([]);
  const [filters, setFilters] = useState({ store_id: '', date_from: '', date_to: '', order_status: '', dispute_status: '', order_tracker: '', va_team: '', review_status: '' });
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [cogsPopoverId, setCogsPopoverId] = useState(null);

  const opts = (key) => customOptions.filter(o => o.field_key === key && o.is_active);

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
    try {
      const res = await fetch(`${apiBase}/market-orders?${params.toString()}`, { headers: authHeaders() });
      const data = await res.json();
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [filters]);

  const openNew = () => {
    setEditing(null);
    setForm({ store_id: stores[0]?.id || '', market_order_id: '', order_date: '', gross_amount: 0, platform_fee: 0, ads_fee: 0, shipping_fee_cost: 0, total_expense: 0, refund_amount: 0, net_earnings: 0 });
    setShowForm(true);
  };

  const openEdit = (o) => {
    setEditing(o);
    setForm(o);
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await fetch(`${apiBase}/market-orders/${editing.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(form) });
      } else {
        const res = await fetch(`${apiBase}/market-orders`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(form) });
        if (!res.ok) { const err = await res.json(); alert(err.error); return; }
      }
      setShowForm(false);
      load();
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Market Orders</h2>
        {canEdit && (
          <button onClick={openNew} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700">
            <Plus size={16} /> New Order
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={filters.store_id} onChange={e => setFilters({...filters, store_id: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Stores</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={e => setFilters({...filters, date_from: e.target.value})} className="border border-gray-300 rounded px-2 py-1" placeholder="From" />
        <input type="date" value={filters.date_to} onChange={e => setFilters({...filters, date_to: e.target.value})} className="border border-gray-300 rounded px-2 py-1" placeholder="To" />
        <select value={filters.order_status} onChange={e => setFilters({...filters, order_status: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Statuses</option>
          <option value="processing">Processing</option>
          <option value="shipped">Shipped</option>
          <option value="refunded_partial">Refunded (Partial)</option>
          <option value="refunded_full">Refunded (Full)</option>
        </select>
        <select value={filters.dispute_status} onChange={e => setFilters({...filters, dispute_status: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Dispute Status</option>
          {opts('dispute_status').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
        </select>
        <select value={filters.order_tracker} onChange={e => setFilters({...filters, order_tracker: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Trackers</option>
          {opts('order_tracker').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              {['', 'Order Date', 'Market Order ID', 'Item', 'Buyer', 'Gross', 'Net Earnings', 'Status', 'Dispute', 'Tracker', 'VA Team', ''].map(h => (
                <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orders.map(o => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-2 py-2 relative">
                  {!o.has_cogs && (
                    <>
                      <button onClick={() => setCogsPopoverId(cogsPopoverId === o.id ? null : o.id)} title="COGS missing" className="text-amber-500 hover:text-amber-600">
                        <AlertTriangle size={15} />
                      </button>
                      {cogsPopoverId === o.id && (
                        <div className="absolute z-20 top-6 left-0 bg-white border border-amber-200 shadow-lg rounded p-3 w-56 text-xs space-y-2">
                          <div className="text-amber-700 font-semibold">COGS missing</div>
                          <div className="text-gray-500">This order has no matched supplier order — its cost isn't counted in profit calculations.</div>
                          <button
                            onClick={() => { setCogsPopoverId(null); onGoToOrderMatching && onGoToOrderMatching(o.market_order_id); }}
                            className="text-emerald-600 hover:underline font-semibold"
                          >
                            View in Order Matching →
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </td>
                <td className="px-3 py-2">{o.order_date}</td>
                <td className="px-3 py-2 font-mono">{o.market_order_id}</td>
                <td className="px-3 py-2 max-w-[160px] truncate">{o.item_title}</td>
                <td className="px-3 py-2">{o.buyer_name}</td>
                <td className="px-3 py-2">${Number(o.gross_amount).toFixed(2)}</td>
                <td className="px-3 py-2">${Number(o.net_earnings).toFixed(2)}</td>
                <td className="px-3 py-2 capitalize">{o.order_status?.replace('_', ' ')}</td>
                <td className="px-3 py-2">{o.dispute_status}</td>
                <td className="px-3 py-2">{o.order_tracker}</td>
                <td className="px-3 py-2">{o.va_team}</td>
                <td className="px-3 py-2">
                  <button onClick={() => openEdit(o)} className="text-emerald-600 hover:underline flex items-center gap-1"><Edit2 size={12} />Edit</button>
                </td>
              </tr>
            ))}
            {orders.length === 0 && !loading && (
              <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-400">No market orders found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold text-lg">{editing ? 'Edit Market Order' : 'New Market Order'}</h3>
              <button onClick={() => setShowForm(false)}><X size={18} /></button>
            </div>
            <form onSubmit={save} className="space-y-3">
              {!editing && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Store</label>
                    <select required value={form.store_id} onChange={e => setForm({...form, store_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                      {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Market Order ID</label>
                    <input required value={form.market_order_id} onChange={e => setForm({...form, market_order_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Order Date</label>
                    <input type="date" required value={form.order_date} onChange={e => setForm({...form, order_date: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                </div>
              )}
              {editing && (
                <div className="text-xs bg-gray-50 border rounded p-3 space-y-1 text-gray-500">
                  <div><b>Market Order ID:</b> {editing.market_order_id} (read-only — correct via re-import)</div>
                  <div><b>Order Date:</b> {editing.order_date}</div>
                  <div><b>Gross:</b> ${Number(editing.gross_amount).toFixed(2)} &nbsp; <b>Net Earnings:</b> ${Number(editing.net_earnings).toFixed(2)}</div>
                  <div><b>Order Status:</b> {editing.order_status}</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 border-t pt-3">
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Dispute Status</label>
                  <select value={form.dispute_status || ''} onChange={e => setForm({...form, dispute_status: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('dispute_status').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Order Tracker</label>
                  <select value={form.order_tracker || ''} onChange={e => setForm({...form, order_tracker: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('order_tracker').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">VA Team</label>
                  <select value={form.va_team || ''} onChange={e => setForm({...form, va_team: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('va_team').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Review Status</label>
                  <select value={form.review_status || ''} onChange={e => setForm({...form, review_status: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('review_status').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Dispute Reason</label>
                  <select value={form.dispute_reason || ''} onChange={e => setForm({...form, dispute_reason: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('dispute_reason').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase">Comments</label>
                <textarea value={form.comments || ''} onChange={e => setForm({...form, comments: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" rows={2} />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase">Order Notes</label>
                <textarea value={form.order_notes || ''} onChange={e => setForm({...form, order_notes: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" rows={2} />
              </div>

              {!editing && (
                <div className="grid grid-cols-3 gap-3 border-t pt-3">
                  {['gross_amount','platform_fee','ads_fee','shipping_fee_cost','total_expense','refund_amount','net_earnings'].map(f => (
                    <div key={f}>
                      <label className="text-xs font-bold text-gray-500 uppercase">{f.replace(/_/g,' ')}</label>
                      <input type="number" step="0.01" value={form[f] || 0} onChange={e => setForm({...form, [f]: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2 border-t pt-3">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-bold">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
