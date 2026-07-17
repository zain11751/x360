import React, { useState, useEffect } from 'react';
import { RefreshCw, AlertTriangle, Link as LinkIcon, X } from 'lucide-react';

export default function OrderMatching({ apiBase, authHeaders, stores, canEdit }) {
  const [matches, setMatches] = useState([]);
  const [filters, setFilters] = useState({ match_status: '', store_id: '' });
  const [editingKeyId, setEditingKeyId] = useState(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [linkModal, setLinkModal] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const load = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
    try {
      const res = await fetch(`${apiBase}/order-matches?${params.toString()}`, { headers: authHeaders() });
      const data = await res.json();
      setMatches(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { load(); }, [filters]);

  const saveParsedKey = async (id) => {
    await fetch(`${apiBase}/order-matches/${id}/parsed-key`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ parsed_match_key: keyDraft }) });
    setEditingKeyId(null);
    load();
  };

  const resetToSystem = async (id) => {
    await fetch(`${apiBase}/order-matches/${id}/reset-to-system`, { method: 'POST', headers: authHeaders() });
    load();
  };

  const removeLink = async (id) => {
    if (!confirm('Remove this link?')) return;
    await fetch(`${apiBase}/order-matches/${id}/remove-link`, { method: 'POST', headers: authHeaders() });
    load();
  };

  const remapAll = async () => {
    await fetch(`${apiBase}/order-matches/remap-all`, { method: 'POST', headers: authHeaders() });
    load();
  };

  const doSearch = async () => {
    if (!linkModal) return;
    const endpoint = linkModal.mode === 'link_supplier' ? 'supplier-orders' : 'market-orders';
    const res = await fetch(`${apiBase}/${endpoint}`, { headers: authHeaders() });
    const data = await res.json();
    const filtered = (Array.isArray(data) ? data : []).filter(r => {
      const idField = linkModal.mode === 'link_supplier' ? r.supplier_order_id : r.market_order_id;
      return !searchTerm || String(idField).toLowerCase().includes(searchTerm.toLowerCase());
    });
    setSearchResults(filtered.slice(0, 20));
  };

  const confirmLink = async (recordId) => {
    const body = linkModal.mode === 'link_supplier' ? { supplier_order_id: recordId } : { market_order_id: recordId };
    await fetch(`${apiBase}/order-matches/${linkModal.matchId}/link`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    setLinkModal(null);
    setSearchResults([]);
    setSearchTerm('');
    load();
  };

  const statusBadge = (s) => {
    const colors = { matched: 'bg-green-100 text-green-700', unmatched_market: 'bg-yellow-100 text-yellow-700', unmatched_supplier: 'bg-orange-100 text-orange-700', error_parse: 'bg-red-100 text-red-700' };
    return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${colors[s] || 'bg-gray-100'}`}>{s.replace('_', ' ')}</span>;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Order Matching</h2>
        {canEdit && (
          <button onClick={remapAll} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white rounded text-sm font-semibold hover:bg-gray-800">
            <RefreshCw size={14} /> Re-map All
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={filters.match_status} onChange={e => setFilters({...filters, match_status: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Statuses</option>
          <option value="matched">Matched</option>
          <option value="unmatched_market">Unmatched (Market)</option>
          <option value="unmatched_supplier">Unmatched (Supplier)</option>
          <option value="error_parse">Error Parse</option>
        </select>
        <select value={filters.store_id} onChange={e => setFilters({...filters, store_id: e.target.value})} className="border border-gray-300 rounded px-2 py-1">
          <option value="">All Stores</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        {matches.map(m => (
          <div key={m.id} className={`border rounded p-3 text-xs ${m.soft_mismatch ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {statusBadge(m.match_status)}
                <span className="text-gray-400">{m.source === 'manual' ? '(manual)' : '(system)'}</span>
                {m.duplicate_claim && <span className="flex items-center gap-1 text-red-600"><AlertTriangle size={12}/>Duplicate claim</span>}
                {m.soft_mismatch && <span className="flex items-center gap-1 text-yellow-700"><AlertTriangle size={12}/>Name/state mismatch</span>}
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  {m.match_status === 'unmatched_market' && (
                    <button onClick={() => setLinkModal({ matchId: m.id, mode: 'link_supplier' })} className="text-blue-600 hover:underline flex items-center gap-1"><LinkIcon size={12}/>Link Supplier Order</button>
                  )}
                  {m.match_status === 'unmatched_supplier' && (
                    <button onClick={() => setLinkModal({ matchId: m.id, mode: 'link_market' })} className="text-blue-600 hover:underline flex items-center gap-1"><LinkIcon size={12}/>Link Market Order</button>
                  )}
                  {m.match_status === 'matched' && m.source === 'manual' && (
                    <>
                      <button onClick={() => resetToSystem(m.id)} className="text-gray-600 hover:underline">Reset to System</button>
                      <button onClick={() => removeLink(m.id)} className="text-red-600 hover:underline">Remove Link</button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-blue-50 rounded p-2">
                <div className="font-bold text-blue-800 mb-1">Market Order</div>
                {m.market_order_id ? (
                  <div>
                    <div>ID: {m.mo_market_order_id}</div>
                    <div>Item: {m.mo_item_title}</div>
                    <div>Buyer: {m.mo_buyer_name} / {m.mo_buyer_state}</div>
                    <div>Date: {m.mo_order_date}</div>
                  </div>
                ) : <div className="text-gray-400">— none —</div>}
              </div>
              <div className="bg-purple-50 rounded p-2">
                <div className="font-bold text-purple-800 mb-1">Supplier Order</div>
                {m.supplier_order_id ? (
                  <div>
                    <div>ID: {m.so_supplier_order_id}</div>
                    <div>Item: {m.so_item_title}</div>
                    <div>Buyer: {m.so_buyer_name} / {m.so_ship_state}</div>
                    <div>Date: {m.so_order_date}</div>
                  </div>
                ) : <div className="text-gray-400">— none —</div>}
              </div>
            </div>

            {m.match_status === 'error_parse' && (
              <div className="mt-2 flex items-center gap-2">
                <span className="font-bold">Parsed Key:</span>
                {editingKeyId === m.id ? (
                  <>
                    <input value={keyDraft} onChange={e => setKeyDraft(e.target.value)} className="border rounded px-2 py-1 text-xs" />
                    <button onClick={() => saveParsedKey(m.id)} className="text-blue-600 hover:underline">Save</button>
                    <button onClick={() => setEditingKeyId(null)} className="text-gray-500 hover:underline">Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="font-mono">{m.parsed_match_key}</span>
                    {canEdit && <button onClick={() => { setEditingKeyId(m.id); setKeyDraft(m.parsed_match_key || ''); }} className="text-blue-600 hover:underline">Edit</button>}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {matches.length === 0 && <div className="text-center text-gray-400 py-8">No order matches found.</div>}
      </div>

      {linkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-lg w-full space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold">{linkModal.mode === 'link_supplier' ? 'Link Supplier Order' : 'Link Market Order'}</h3>
              <button onClick={() => { setLinkModal(null); setSearchResults([]); }}><X size={18} /></button>
            </div>
            <div className="flex gap-2">
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search by ID..." className="flex-1 border rounded px-2 py-1.5 text-sm" />
              <button onClick={doSearch} className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm">Search</button>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {searchResults.map(r => (
                <div key={r.id} className="flex items-center justify-between border rounded px-2 py-1.5 text-xs">
                  <span>{linkModal.mode === 'link_supplier' ? r.supplier_order_id : r.market_order_id} — {r.item_title}</span>
                  <button onClick={() => confirmLink(r.id)} className="text-blue-600 hover:underline">Select</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
