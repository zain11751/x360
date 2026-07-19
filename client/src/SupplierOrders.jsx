import React, { useState, useEffect } from 'react';
import { Plus, X, Edit2 } from 'lucide-react';

export default function SupplierOrders({ apiBase, authHeaders, stores, customOptions, canEdit }) {
  const [orders, setOrders] = useState([]);
  const [filters, setFilters] = useState({ store_id: '', source_vendor: '', date_from: '', date_to: '', dispute_status: '', order_status: '' });
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({});

  const opts = (key) => customOptions.filter(o => o.field_key === key && o.is_active);

  const load = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
    try {
      const res = await fetch(`${apiBase}/supplier-orders?${params.toString()}`, { headers: authHeaders() });
      const data = await res.json();
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { load(); }, [filters]);

  const openNew = () => {
    setEditing(null);
    setForm({ store_id: stores[0]?.id || '', source_vendor: '', supplier_order_id: '', supplier_order_date: '', supplier_order_total: 0 });
    setShowForm(true);
  };
  const openEdit = (o) => { setEditing(o); setForm(o); setShowForm(true); };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await fetch(`${apiBase}/supplier-orders/${editing.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(form) });
      } else {
        const res = await fetch(`${apiBase}/supplier-orders`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(form) });
        if (!res.ok) { const err = await res.json(); alert(err.error); return; }
      }
      setShowForm(false);
      load();
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Supplier Orders</h2>
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
        <input value={filters.source_vendor} onChange={e => setFilters({...filters, source_vendor: e.target.value})} placeholder="Vendor" className="border border-gray-300 rounded px-2 py-1" />
        <input type="date" value={filters.date_from} onChange={e => setFilters({...filters, date_from: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
        <input type="date" value={filters.date_to} onChange={e => setFilters({...filters, date_to: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
        <select value={filters.dispute_status} onChange={e => setFilters({...filters, dispute_status: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Dispute Status</option>
          {opts('dispute_status').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
        </select>
        <select value={filters.order_status} onChange={e => setFilters({...filters, order_status: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Order Status</option>
          <option value="Order Paid">Order Paid (not refunded)</option>
          <option value="Refunded (Partial)">Refunded (Partial)</option>
          <option value="Refunded (Full)">Refunded (Full)</option>
        </select>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              {['Date', 'Vendor', 'Supplier Order ID', 'Match Key', 'Total', 'Total Cost', 'Status', 'Dispute', ''].map(h => (
                <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orders.map(o => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">{o.supplier_order_date}</td>
                <td className="px-3 py-2">{o.source_vendor}</td>
                <td className="px-3 py-2 font-mono">{o.supplier_order_id}</td>
                <td className="px-3 py-2 font-mono">{o.match_key}</td>
                <td className="px-3 py-2">${Number(o.supplier_order_total).toFixed(2)}</td>
                <td className="px-3 py-2">${Number(o.total_cost).toFixed(2)}</td>
                <td className="px-3 py-2">{o.order_status}</td>
                <td className="px-3 py-2">{o.dispute_status}</td>
                <td className="px-3 py-2">
                  <button onClick={() => openEdit(o)} className="text-emerald-600 hover:underline flex items-center gap-1"><Edit2 size={12} />Edit</button>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">No supplier orders found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold text-lg">{editing ? 'Edit Supplier Order' : 'New Supplier Order'}</h3>
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
                    <label className="text-xs font-bold text-gray-500 uppercase">Source Vendor</label>
                    <input required value={form.source_vendor} onChange={e => setForm({...form, source_vendor: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Supplier Order ID</label>
                    <input required value={form.supplier_order_id} onChange={e => setForm({...form, supplier_order_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Match Key</label>
                    <input value={form.match_key || ''} onChange={e => setForm({...form, match_key: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Order Date</label>
                    <input type="date" required value={form.supplier_order_date} onChange={e => setForm({...form, supplier_order_date: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-gray-500 uppercase">Order Total</label>
                    <input type="number" step="0.01" required value={form.supplier_order_total} onChange={e => setForm({...form, supplier_order_total: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" />
                  </div>
                </div>
              )}
              {editing && (
                <div className="text-xs bg-gray-50 border rounded p-3 space-y-1 text-gray-500">
                  <div><b>Supplier Order ID:</b> {editing.supplier_order_id} (read-only — correct via re-import)</div>
                  <div><b>Total:</b> ${Number(editing.supplier_order_total).toFixed(2)} &nbsp; <b>Total Cost:</b> ${Number(editing.total_cost).toFixed(2)}</div>
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
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase">Comments</label>
                <textarea value={form.comments || ''} onChange={e => setForm({...form, comments: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" rows={2} />
              </div>

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
