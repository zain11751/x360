import React, { useState, useEffect, useRef } from 'react';
import { Upload, Download, RefreshCw, X } from 'lucide-react';

const EARNINGS_FIELDS = ['market_order_id','order_date','item_title','buyer_name','buyer_state','gross_amount','platform_fee','ads_fee','shipping_fee_cost','total_expense','refund_amount','net_earnings'];
const SUPPLIER_FIELDS = ['supplier_order_id','source_vendor','supplier_store_name','match_key','supplier_order_date','supplier_order_status','item_title','order_qty','unit_price','shipping_cost','price_adjustment','discount_total','other_total','tax_total','supplier_order_total','payment_method','tracking_number','tracking_carrier','buyer_name','ship_state','supplier_refund_status','refunded_amount','date_refunded','supplier_notes'];
const TRANSACTION_FIELDS = ['transaction_date','transaction_type','market_order_id','net_amount','gross_transaction_amount','payout_batch_id','payout_date','payout_status','item_title','description'];
const TRANSACTIONS_AUTOMAP = {
  transaction_date: ['Transaction creation date'],
  transaction_type: ['Type'],
  market_order_id: ['Order number'],
  net_amount: ['Net amount'],
  gross_transaction_amount: ['Gross transaction amount'],
  payout_batch_id: ['Payout ID'],
  payout_date: ['Payout date'],
  payout_status: ['Payout status'],
  item_title: ['Item title'],
  description: ['Description']
};

const EBAY_EARNINGS_AUTOMAP = { market_order_id: 'Order number', order_date: 'Order creation date', item_title: 'Item title', buyer_name: 'Buyer name', buyer_state: 'Ship to province/region/state', gross_amount: 'Gross amount', platform_fee: { sum: ['Final Value Fee - fixed', 'Final Value Fee - variable'] }, ads_fee: 'Promoted Listing Standard fee', shipping_fee_cost: 'Shipping labels', total_expense: 'Expenses', refund_amount: 'Refunds', net_earnings: 'Order earnings' };
const SUPPLIER_AUTOMAP = { source_vendor: ['Source_Vendor', 'Supplier', 'source_site'], supplier_store_name: ['supplier_store_name'], supplier_order_id: ['supplier_order_id', 'Order ID'], match_key: ['Match Key / Reference Order Number', 'Order ID', 'supplier_order_id', 'linked_sales_order_id'], supplier_order_date: ['supplier_order_date'], supplier_order_status: ['supplier_order_status'], item_title: ['item_titles'], order_qty: ['order_qty', 'item_count'], unit_price: ['unit_price', 'Item Cost', 'item_subtotal'], shipping_cost: ['shipping_cost'], price_adjustment: ['price_adjustment'], discount_total: ['discount_total'], other_total: ['other_total'], tax_total: ['tax_total'], supplier_order_total: ['supplier_order_total'], payment_method: ['payment_method'], tracking_number: ['tracking_number'], tracking_carrier: ['tracking_carrier'], buyer_name: ['buyer_name'], ship_state: ['ship_state_region'], supplier_refund_status: ['supplier_refund_status', 'refund_status'], refunded_amount: ['Refunded_Amount', 'refund_amount_actually_paid'], date_refunded: ['Date_Refunded', 'refund_solution_time'], supplier_notes: ['Supplier_Notes', 'manual_notes'] };

export default function ImportCenter({ apiBase, authHeaders, stores }) {
  const [view, setView] = useState('import'); // import | logs | detail
  const [storeId, setStoreId] = useState('');
  const [importType, setImportType] = useState('market_orders');
  const [marketOrderSource, setMarketOrderSource] = useState('earnings');
  const [fileContent, setFileContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logDetail, setLogDetail] = useState(null);
  const [retryRow, setRetryRow] = useState(null);
  const [retryForm, setRetryForm] = useState({});
  const fileInputRef = useRef();

  const selectedStore = stores.find(s => s.id === storeId);
  const fields = importType === 'market_orders' ? (marketOrderSource === 'earnings' ? EARNINGS_FIELDS : ['market_order_id']) : (importType === 'supplier_orders' ? SUPPLIER_FIELDS : TRANSACTION_FIELDS);

  const loadLogs = async () => {
    const res = await fetch(`${apiBase}/import-center/logs`, { headers: authHeaders() });
    setLogs(await res.json());
  };
  useEffect(() => { if (view === 'logs') loadLogs(); }, [view]);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setFileContent(ev.target.result);
    reader.readAsText(file);
  };

  const doPreview = async () => {
    if (!fileContent) { alert('Choose a file first'); return; }
    const res = await fetch(`${apiBase}/import-center/preview`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ file_content: fileContent }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    setPreview(data);

    // Auto-fill mapping based on adapter, if headers match
    let automap = {};
    if (importType === 'market_orders' && marketOrderSource === 'earnings') automap = EBAY_EARNINGS_AUTOMAP;
    else if (importType === 'supplier_orders') automap = SUPPLIER_AUTOMAP;
    else if (importType === 'transactions') automap = TRANSACTIONS_AUTOMAP;
    const initialMapping = {};
    fields.forEach(f => {
      const guess = automap[f];
      if (guess && typeof guess === 'object' && !Array.isArray(guess) && guess.sum) {
        // Explicit sum-of-columns (e.g. two fee columns added together)
        const allPresent = guess.sum.every(g => data.headers.includes(g));
        initialMapping[f] = allPresent ? guess.sum : '';
      } else if (Array.isArray(guess)) {
        // Candidate list — different export tools use different column names for the same field;
        // use whichever candidate actually appears in this file.
        const found = guess.find(g => data.headers.includes(g));
        initialMapping[f] = found || '';
      } else if (guess && data.headers.includes(guess)) {
        initialMapping[f] = guess;
      } else {
        initialMapping[f] = '';
      }
    });
    setMapping(initialMapping);
  };

  const doCommit = async () => {
    setCommitting(true);
    try {
      const res = await fetch(`${apiBase}/import-center/commit`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ store_id: storeId, import_type: importType, market_order_source: importType === 'market_orders' ? marketOrderSource : undefined, file_name: fileName, file_content: fileContent, column_mapping: mapping })
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); setCommitting(false); return; }
      setResult(data);
      setPreview(null);
      setFileContent('');
      setFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) { alert('Import failed: ' + e.message); }
    setCommitting(false);
  };

  const openLogDetail = async (logId) => {
    const res = await fetch(`${apiBase}/import-center/logs/${logId}`, { headers: authHeaders() });
    setLogDetail(await res.json());
    setView('detail');
  };

  const exportFailed = (logId) => {
    window.open(`${apiBase}/import-center/logs/${logId}/export-failed`, '_blank');
  };

  const submitRetry = async (e) => {
    e.preventDefault();
    const res = await fetch(`${apiBase}/import-center/logs/${logDetail.log.id}/rows/${retryRow.id}/retry`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ corrected_data: retryForm }) });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    setRetryRow(null);
    openLogDetail(logDetail.log.id);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">Import Center</h2>
        <div className="flex gap-2 text-sm">
          <button onClick={() => setView('import')} className={`px-3 py-1 rounded ${view === 'import' ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}>New Import</button>
          <button onClick={() => setView('logs')} className={`px-3 py-1 rounded ${view === 'logs' || view === 'detail' ? 'bg-emerald-600 text-white' : 'bg-gray-100'}`}>Import Logs</button>
        </div>
      </div>

      {view === 'import' && (
        <div className="space-y-4 max-w-2xl">
          {result && (
            <div className="border border-green-300 bg-green-50 rounded p-3 text-sm">
              Import complete: {result.success_rows} succeeded, {result.failed_rows} failed, {result.skipped_rows} skipped duplicates. Status: {result.status}.
              <button onClick={() => openLogDetail(result.import_log_id)} className="ml-2 text-emerald-600 hover:underline">View Detail</button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase">Store</label>
              <select value={storeId} onChange={e => { setStoreId(e.target.value); setPreview(null); }} className="w-full border rounded px-2 py-1.5 text-sm">
                <option value="">Select store...</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name} ({s.platform})</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase">Import Type</label>
              <select value={importType} onChange={e => { setImportType(e.target.value); setPreview(null); }} className="w-full border rounded px-2 py-1.5 text-sm">
                <option value="market_orders">Market Orders</option>
                <option value="supplier_orders">Supplier Orders</option>
                <option value="transactions">Transactions</option>
              </select>
            </div>
            {importType === 'market_orders' && (
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase">Market Order Source</label>
                <select value={marketOrderSource} onChange={e => { setMarketOrderSource(e.target.value); setPreview(null); }} className="w-full border rounded px-2 py-1.5 text-sm">
                  <option value="earnings">Order Earnings</option>
                  <option value="orders_report">Orders Report</option>
                </select>
              </div>
            )}
          </div>

          {selectedStore && selectedStore.platform === 'other' && (
            <div className="text-xs bg-yellow-50 border border-yellow-200 rounded p-2 text-yellow-800">This store's platform is "other" — no adapter template exists. Column mapping starts blank.</div>
          )}

          <div>
            <label className="text-xs font-bold text-gray-500 uppercase">CSV File</label>
            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFile} className="block w-full text-sm border rounded px-2 py-1.5" />
          </div>

          <button onClick={doPreview} disabled={!storeId || !fileContent} className="flex items-center gap-1 px-4 py-2 bg-gray-700 text-white rounded text-sm font-semibold disabled:opacity-40">
            <Upload size={14} /> Preview & Map Columns
          </button>

          {preview && (
            <div className="border rounded p-4 space-y-3">
              <h3 className="font-bold text-sm">Column Mapping ({preview.total_rows} rows detected)</h3>
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {fields.map(f => {
                  const current = mapping[f];
                  const currentArr = Array.isArray(current) ? current : (current ? [current] : []);
                  return (
                    <div key={f} className="flex items-start gap-2 text-xs">
                      <label className="w-40 font-semibold text-gray-600 pt-1">{f.replace(/_/g,' ')}</label>
                      <div className="flex-1">
                        <select
                          multiple
                          size={Math.min(4, Math.max(2, preview.headers.length > 20 ? 3 : 2))}
                          value={currentArr}
                          onChange={e => {
                            const selected = Array.from(e.target.selectedOptions).map(o => o.value);
                            setMapping({ ...mapping, [f]: selected.length <= 1 ? (selected[0] || '') : selected });
                          }}
                          className="w-full border rounded px-1 py-1"
                        >
                          {preview.headers.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        {currentArr.length > 1 && <div className="text-[10px] text-gray-400 mt-0.5">Summing {currentArr.length} columns</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-gray-400">Hold Ctrl (Windows) or Cmd (Mac) and click to select more than one column for a field that should be summed (e.g. two fee columns added together).</p>

              <h4 className="font-bold text-xs mt-2">Preview (first {preview.preview.length} rows)</h4>
              <div className="overflow-x-auto border rounded max-h-40">
                <table className="min-w-full text-[10px]">
                  <thead className="bg-gray-50"><tr>{preview.headers.map(h => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody>
                    {preview.preview.map((r, i) => (
                      <tr key={i} className="border-t">{preview.headers.map(h => <td key={h} className="px-2 py-1">{r[h]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button onClick={doCommit} disabled={committing} className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-bold disabled:opacity-50">
                {committing ? 'Importing...' : 'Confirm Import'}
              </button>
            </div>
          )}
        </div>
      )}

      {view === 'logs' && (
        <div className="overflow-x-auto border rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50"><tr>{['File','Type','Total','Success','Failed','Skipped','Status','Date',''].map(h => <th key={h} className="px-3 py-2 text-left font-bold text-gray-500 uppercase">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">{l.file_name}</td>
                  <td className="px-3 py-2">{l.import_type}</td>
                  <td className="px-3 py-2">{l.total_rows}</td>
                  <td className="px-3 py-2 text-green-600">{l.success_rows}</td>
                  <td className="px-3 py-2 text-red-600">{l.failed_rows}</td>
                  <td className="px-3 py-2">{l.skipped_rows}</td>
                  <td className="px-3 py-2">{l.status}</td>
                  <td className="px-3 py-2">{new Date(l.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2"><button onClick={() => openLogDetail(l.id)} className="text-emerald-600 hover:underline">Detail</button></td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">No import logs found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === 'detail' && logDetail && (
        <div className="space-y-4">
          <button onClick={() => setView('logs')} className="text-sm text-emerald-600 hover:underline">&larr; Back to Logs</button>
          <div className="text-sm bg-gray-50 border rounded p-3">
            <b>{logDetail.log.file_name}</b> — {logDetail.log.import_type} — {logDetail.log.status} — {logDetail.log.success_rows} success / {logDetail.log.failed_rows} failed / {logDetail.log.skipped_rows} skipped
            {logDetail.log.failed_rows > 0 && (
              <button onClick={() => exportFailed(logDetail.log.id)} className="ml-3 text-emerald-600 hover:underline flex items-center gap-1 inline-flex"><Download size={12}/>Export Failed Rows</button>
            )}
          </div>

          <div>
            <h4 className="font-bold text-sm mb-2">Successful Rows</h4>
            <div className="text-xs max-h-40 overflow-y-auto border rounded p-2">
              {logDetail.rows.filter(r => r.row_status === 'success').map(r => <div key={r.id}>Row {r.row_number} — created/updated record {r.created_record_id}</div>)}
            </div>
          </div>

          <div>
            <h4 className="font-bold text-sm mb-2">Failed Rows</h4>
            <div className="space-y-2">
              {logDetail.rows.filter(r => r.row_status === 'failed').map(r => (
                <div key={r.id} className="border border-red-200 bg-red-50 rounded p-2 text-xs">
                  <div><b>Row {r.row_number}:</b> {r.error_reason}</div>
                  <button onClick={() => { setRetryRow(r); setRetryForm(typeof r.raw_row_data === 'string' ? JSON.parse(r.raw_row_data) : r.raw_row_data); }} className="text-emerald-600 hover:underline mt-1"><RefreshCw size={10} className="inline mr-1"/>Fix & Retry</button>
                </div>
              ))}
              {logDetail.rows.filter(r => r.row_status === 'failed').length === 0 && <div className="text-gray-400 text-xs">No failed rows.</div>}
            </div>
          </div>
        </div>
      )}

      {retryRow && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-3">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="font-bold">Fix & Retry Row {retryRow.row_number}</h3>
              <button onClick={() => setRetryRow(null)}><X size={18}/></button>
            </div>
            <form onSubmit={submitRetry} className="space-y-2">
              {Object.keys(retryForm).map(k => (
                <div key={k}>
                  <label className="text-xs font-bold text-gray-500 uppercase">{k}</label>
                  <input value={retryForm[k] || ''} onChange={e => setRetryForm({...retryForm, [k]: e.target.value})} className="w-full border rounded px-2 py-1 text-sm" />
                </div>
              ))}
              <div className="flex justify-end gap-2 border-t pt-3">
                <button type="button" onClick={() => setRetryRow(null)} className="px-4 py-2 border rounded text-sm">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-bold">Retry</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
