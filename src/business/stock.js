const { all, run, transaction } = require('../db/db');

function replaceStockMovements({ orgId, sourceType, sourceId, date, refNumber, items, direction }) {
  transaction(() => {
    run('DELETE FROM stock_movements WHERE org_id=? AND source_type=? AND source_id=?',
      [orgId, sourceType, sourceId]);
    (items || []).forEach(item => {
      const itemId = Number(item.item_id);
      const qty = Number(item.qty || 0);
      if (!itemId || qty <= 0) return;
      run(
        `INSERT INTO stock_movements
         (org_id,item_id,movement_date,source_type,source_id,ref_number,qty_in,qty_out,rate)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [orgId, itemId, date, sourceType, sourceId, refNumber,
         direction === 'in' ? qty : 0, direction === 'out' ? qty : 0, Number(item.rate || 0)]
      );
    });
  });
}

function removeStockMovements(orgId, sourceType, sourceId) {
  run('DELETE FROM stock_movements WHERE org_id=? AND source_type=? AND source_id=?',
    [orgId, sourceType, sourceId]);
}

function replaceStockCountMovements({ orgId, countId, countDate, countNumber, lines }) {
  transaction(() => {
    run('DELETE FROM stock_movements WHERE org_id=? AND source_type=? AND source_id=?',
      [orgId, 'stock_count', countId]);
    (lines || []).forEach(line => {
      const variance = Number(line.variance_qty || 0);
      if (!Number(line.item_id) || Math.abs(variance) < 0.0001) return;
      run(
        `INSERT INTO stock_movements
         (org_id,item_id,movement_date,source_type,source_id,ref_number,qty_in,qty_out,rate)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [orgId, Number(line.item_id), countDate, 'stock_count', countId, countNumber,
          variance > 0 ? variance : 0, variance < 0 ? Math.abs(variance) : 0,
          Number(line.rate_snapshot || 0)]
      );
    });
  });
}

function stockSummary(orgId) {
  return all(
    `SELECT i.*,ic.name category_name,
      ROUND(COALESCE(i.opening_stock,0)+COALESCE(SUM(sm.qty_in-sm.qty_out),0),3) current_stock
     FROM items i
     LEFT JOIN item_categories ic ON ic.id=i.category_id
     LEFT JOIN stock_movements sm ON sm.item_id=i.id AND sm.org_id=i.org_id
     WHERE i.org_id=? AND i.active=1
     GROUP BY i.id ORDER BY i.name`,
    [orgId]
  );
}

function lowStockSummary(orgId) {
  return all(
    `SELECT i.*,ic.name category_name,
      ROUND(COALESCE(i.opening_stock,0)+COALESCE(SUM(sm.qty_in-sm.qty_out),0),3) current_stock
     FROM items i
     LEFT JOIN item_categories ic ON ic.id=i.category_id
     LEFT JOIN stock_movements sm ON sm.item_id=i.id AND sm.org_id=i.org_id
     WHERE i.org_id=? AND i.active=1 AND COALESCE(i.reorder_level,0)>0
     GROUP BY i.id
     HAVING ROUND(COALESCE(i.opening_stock,0)+COALESCE(SUM(sm.qty_in-sm.qty_out),0),3)
       <= COALESCE(i.reorder_level,0)
     ORDER BY i.name`,
    [orgId]
  );
}

function validateStockAvailability(orgId, items, excludeSourceId = null) {
  const stock = new Map(stockSummary(orgId).map(item => [Number(item.id), Number(item.current_stock || 0)]));
  if (excludeSourceId) {
    all(`SELECT item_id,qty_out FROM stock_movements
         WHERE org_id=? AND source_type='bill' AND source_id=?`, [orgId, excludeSourceId])
      .forEach(row => stock.set(Number(row.item_id), Number(stock.get(Number(row.item_id)) || 0) + Number(row.qty_out || 0)));
  }
  const shortages = [];
  (items || []).forEach(item => {
    const itemId = Number(item.item_id);
    const qty = Number(item.qty || 0);
    if (!itemId || qty <= 0) return;
    const available = Number(stock.get(itemId) || 0);
    if (qty > available + 0.0001) shortages.push({
      item_id: itemId, item_name: item.item_name || `Item ${itemId}`, requested: qty, available
    });
  });
  return shortages;
}

module.exports = {
  replaceStockMovements, replaceStockCountMovements, removeStockMovements,
  stockSummary, lowStockSummary, validateStockAvailability
};
