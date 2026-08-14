const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-2.4.0.js'), 'utf8');
const historyStart = source.indexOf('function openSavedTransactionHistory(type)');
const historyEnd = source.indexOf('\n}', historyStart) + 2;
const historyFunction = source.slice(historyStart, historyEnd);
const saveStart = source.indexOf('async function saveBill(format)');
const saveEnd = source.indexOf('\nasync function offerLinkedBankReceipt', saveStart);
const saveFunction = source.slice(saveStart, saveEnd);

assert.ok(historyStart >= 0, 'Saved transaction history function is missing');
assert.match(historyFunction, /navigate\('bills-list', \{ preserveDraft: false \}\)/,
  'Opening saved history must not re-save the old transaction draft');
assert.match(saveFunction, /clearTransactionDraft\(APP_STATE\.currentPage\);\s*APP_STATE\.editingBill = null;/,
  'Saving a bill must clear the old edit state before opening the next transaction');
assert.match(saveFunction, /billSaveInFlight = true;/,
  'Saving a bill must prevent duplicate submissions while the request is active');
assert.match(source, /function confirmExactTypedBillParty\(\)/,
  'Saving must repair a unique exact typed party name before rejecting the transaction');
assert.match(source, /const localMatches = matches\.filter\(p => Number\(p\.org_id\) === Number\(APP_STATE\.currentOrg\?\.id\)\);/,
  'A same-name shared party must not block the sole party belonging to the current company');
assert.match(source, /matches\.length === 1 \? matches\[0\] : \(localMatches\.length === 1 \? localMatches\[0\] : null\)/,
  'Only a unique exact match or a sole local match may be automatically selected');
assert.match(source, /onblur="setTimeout\(confirmExactTypedBillParty,120\)"/,
  'Leaving the customer field must confirm a safe exact match before saving');
console.log('Transaction reset regression tests passed');
