import React, { useState, useEffect } from 'react';
import { X, ExternalLink, AlertTriangle } from 'lucide-react';

export default function OrderDetailModal({ apiBase, authHeaders, marketOrderId, onClose, onGoToOrderMatching }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!marketOrderId) return;
    setLoading(true);
    setError('');
    fetch(`${apiBase}/market-orders/${marketOrderId}/detail`, { headers: authHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) { setError(data.error || 'Failed to load order detail'); return; }
        setDetail(data);
      })
      .catch(() => setError('Failed to load order detail'))
      .finally(() => setLoading(false));
  }, [marketOrderId]);

  if (!marketOrderId) return null;

  const mo = detail?.market_order;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3 sticky top-0 bg-white">
          <h3 className="font-bold text-gray-800">Order Detail</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          {loading && <div className="text-center text-gray-400 py-8 text-xs">Loading...</div>}
          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded p-3">{error}</div>}

          {mo && (
            <>
              {/* eBay side */}
              <div className="bg-blue-50 rounded-lg p-4 space-y-1.5">
                <div className="font-bold text-blue-800 text-xs uppercase tracking-wide mb-2">eBay Order</div>
                <div className="grid grid-cols-2 gap-y-1 text-xs">
                  <span className="text-gray-500">Order Number</span><span className="font-mono text-right">{mo.market_order_id}</span>
                  <span className="text-gray-500">Item</span><span className="text-right truncate">{mo.item_title}</span>
                  <span className="text-gray-500">Order Date</span><span className="text-right">{mo.order_date}</span>
                  <span className="text-gray-500">Total Price (Sold For)</span><span className="text-right font-semibold">${Number(mo.gross_amount).toFixed(2)}</span>
                  <span className="text-gray-500">Earnings (Received)</span><span className="text-right font-semibold">${Number(mo.net_earnings).toFixed(2)}</span>
                  <span className="text-gray-500">Status</span><span className="text-right capitalize">{mo.order_status?.replace('_', ' ')}</span>
                  {Number(mo.refund_amount) > 0 && (
                    <><span className="text-gray-500">Refunded</span><span className="text-right text-red-600 font-semibold">${Number(mo.refund_amount).toFixed(2)}</span></>
                  )}
                </div>
              </div>

              {/* AliExpress side */}
              <div className="bg-purple-50 rounded-lg p-4 space-y-3">
                <div className="font-bold text-purple-800 text-xs uppercase tracking-wide">AliExpress Order{detail.supplier_orders.length > 1 ? 's' : ''}</div>
                {detail.supplier_orders.length === 0 ? (
                  <div className="flex items-start gap-2 text-amber-700 text-xs bg-amber-50 border border-amber-200 rounded p-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>No matching supplier order found — this order's cost isn't counted in profit calculations.</span>
                  </div>
                ) : (
                  detail.supplier_orders.map(so => (
                    <div key={so.id} className="grid grid-cols-2 gap-y-1 text-xs border-t border-purple-100 pt-2 first:border-0 first:pt-0">
                      <span className="text-gray-500">Order Number</span><span className="font-mono text-right">{so.supplier_order_id}</span>
                      <span className="text-gray-500">Item</span><span className="text-right truncate">{so.item_title}</span>
                      <span className="text-gray-500">Quantity</span><span className="text-right">{so.order_qty}</span>
                      <span className="text-gray-500">Bought For</span><span className="text-right font-semibold">${Number(so.supplier_order_total).toFixed(2)}</span>
                      {Number(so.refunded_amount) > 0 && (
                        <><span className="text-gray-500">Refunded</span><span className="text-right text-red-600 font-semibold">${Number(so.refunded_amount).toFixed(2)}</span></>
                      )}
                      <span className="text-gray-500">Net Cost</span><span className="text-right font-semibold">${Number(so.total_cost).toFixed(2)}</span>
                    </div>
                  ))
                )}
              </div>

              <button
                onClick={() => onGoToOrderMatching && onGoToOrderMatching(mo.market_order_id)}
                className="flex items-center gap-1.5 text-emerald-600 hover:underline text-xs font-semibold"
              >
                <ExternalLink size={12} /> View in Order Matching
              </button>

              {/* Total profit */}
              <div className="border-t pt-3 flex items-center justify-between">
                <span className="font-bold text-gray-700">Total Profit</span>
                <span className={`text-xl font-bold font-mono ${detail.net_profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  ${Number(detail.net_profit).toFixed(2)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
