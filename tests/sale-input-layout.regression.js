'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'app-2.4.0.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.match(source, /const TRANSACTION_FOCUS_PAGES = new Set/, 'Transaction focus-page registry is missing');
assert.match(source, /setTransactionFocusMode\(page\)/, 'Navigation does not activate transaction Focus Mode');
assert.match(index, /id="transaction-focus-menu"/, 'The Focus Mode menu control is missing');
assert.match(styles, /body\.transaction-focus-mode #sidebar \{ display:none; \}/, 'Desktop Focus Mode does not hide the sidebar');

assert.match(source, /class="sale-command-surface"/, 'The approved Sale command header is missing');
assert.match(source, /class="sale-document-meta"/, 'Date, invoice number, and company are not grouped in the Sale header');
assert.match(source, /id="sale-billing-address-summary"/, 'The customer billing-address snapshot is missing');
assert.match(source, /function openSaleMoreDetails\(\)/, 'The F4 details drawer open handler is missing');
assert.match(source, /event\.key === 'F4'/, 'The F4 keyboard shortcut is missing');
assert.match(styles, /\.sale-more-drawer/, 'The Sale details drawer styling is missing');

assert.match(source, /function multilineHtml\(value\)/, 'Safe multiline preview rendering is missing');
assert.ok((source.match(/multilineHtml\(bill\.description\)/g) || []).length >= 2,
  'Bill and project-printing previews must preserve description line breaks');
assert.match(source, /function shouldCapitalizeEntryField\(input\)/, 'Safe business-field capitalization filter is missing');
assert.match(source, /email\|gstin\|gst\|pan\|hsn/, 'Protected identifiers are not excluded from capitalization');
assert.match(source, /renderItemRow\(billItems\[billItems\.length - 1\], billItems\.length - 1, activeBillFormat === 'DC'\)/,
  'New Delivery Challan rows must retain Delivery Challan behavior');

console.log('Sale input layout, Focus Mode, capitalization, and multiline preview tests passed');
