import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';

export default function IncomeTab({ apiBase, authHeaders, stores, customOptions, selectedStoreIds, canEdit }) {
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ store_id: '', date_from: '', date_to: '', va_team: '', linked: '' });
  const [showForm, setShowForm] = useState(false);
  const [marketOrders, setMarketOrders] = useState([]);
  const [supplierOrders, setSupplierOrders] = useState([]);
  const [form, setForm] = useState({ reference_id: '', source_name: '', invoice_url: '', income_date: '', amount: 0, description: '', linked_order_id: '', linked_supplier_order_id: '', va_team: '', store_id: '' });

  const opts = (key) => customOptions.filter(o => o.field_key === key && o.is_active);

  const load = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
    const res = await fetch(`${apiBase}/income?${params.toString()}`, { headers: authHeaders() });
    const data = await res.json();
    setRows(Array.isArray(data) ? data : []);
  };
  useEffect(() => { load(); }, [filters]);

  const openNew = async () => {
    setForm({ reference_id: '', source_name: '', invoice_url: '', income_date: '', amount: 0, description: '', linked_order_id: '', linked_supplier_order_id: '', va_team: '', store_id: selectedStoreIds[0] || stores[0]?.id || '' });
    const [moRes, soRes] = await Promise.all([
      fetch(`${apiBase}/market-orders`, { headers: authHeaders() }),
      fetch(`${apiBase}/supplier-orders`, { headers: authHeaders() })
    ]);
    setMarketOrders(await moRes.json());
    setSupplierOrders(await soRes.json());
    setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    const payload = { ...form, linked_order_id: form.linked_order_id || null, linked_supplier_order_id: form.linked_supplier_order_id || null };
    const res = await fetch(`${apiBase}/income`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) { const err = await res.json(); alert(err.error); return; }
    setShowForm(false);
    load();
  };

  const isLinked = !!(form.linked_order_id || form.linked_supplier_order_id);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Income</h2>
        {canEdit && <button onClick={openNew} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-semibold hover:bg-blue-700"><Plus size={16}/>New Income</button>}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={filters.store_id} onChange={e => setFilters({...filters, store_id: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Stores</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={e => setFilters({...filters, date_from: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
        <input type="date" value={filters.date_to} onChange={e => setFilters({...filters, date_to: e.target.value})} className="border border-gray-300 rounded px-2 py-1" />
        <select value={filters.va_team} onChange={e => setFilters({...filters, va_team: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All VA Teams</option>
          {opts('va_team').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
        </select>
        <select value={filters.linked} onChange={e => setFilters({...filters, linked: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">Linked & Unlinked</option>
          <option value="true">Linked Only</option>
          <option value="false">Unlinked Only</option>
        </select>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>{['Date','Reference ID','Source','Amount','VA Team','Linked','Description'].map(h => <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">{r.income_date}</td>
                <td className="px-3 py-2">{r.reference_id}</td>
                <td className="px-3 py-2">{r.source_name}</td>
                <td className="px-3 py-2">${Number(r.amount).toFixed(2)}</td>
                <td className="px-3 py-2">{r.va_team}</td>
                <td className="px-3 py-2">{(r.linked_order_id || r.linked_supplier_order_id) ? 'Yes' : 'No'}</td>
                <td className="px-3 py-2 max-w-[200px] truncate">{r.description}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No income records found.</td></tr>}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold text-lg">New Income</h3>
              <button onClick={() => setShowForm(false)}><X size={18}/></button>
            </div>
            <form onSubmit={save} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-bold text-gray-500 uppercase">Reference ID</label><input required value={form.reference_id} onChange={e => setForm({...form, reference_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase">Source Name</label><input required value={form.source_name} onChange={e => setForm({...form, source_name: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase">Income Date</label><input type="date" required value={form.income_date} onChange={e => setForm({...form, income_date: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm"/></div>
                <div><label className="text-xs font-bold text-gray-500 uppercase">Amount</label><input type="number" step="0.01" required value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm"/></div>
                <div className="col-span-2"><label className="text-xs font-bold text-gray-500 uppercase">Invoice URL</label><input value={form.invoice_url} onChange={e => setForm({...form, invoice_url: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm"/></div>
                <div className="col-span-2"><label className="text-xs font-bold text-gray-500 uppercase">Description</label><textarea required value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm" rows={2}/></div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Link Market Order</label>
                  <select value={form.linked_order_id} onChange={e => setForm({...form, linked_order_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {marketOrders.map(m => <option key={m.id} value={m.id}>{m.market_order_id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Link Supplier Order</label>
                  <select value={form.linked_supplier_order_id} onChange={e => setForm({...form, linked_supplier_order_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {supplierOrders.map(s => <option key={s.id} value={s.id}>{s.supplier_order_id}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">VA Team</label>
                  <select value={form.va_team} onChange={e => setForm({...form, va_team: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">—</option>
                    {opts('va_team').map(o => <option key={o.id} value={o.option_label}>{o.option_label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase">Store {isLinked && '(auto-filled)'}</label>
                  <select disabled={isLinked} value={form.store_id} onChange={e => setForm({...form, store_id: e.target.value})} className="w-full border rounded px-2 py-1.5 text-sm disabled:bg-gray-100">
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t pt-3">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-bold">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
