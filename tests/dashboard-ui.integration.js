const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-2.4.0.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

assert.match(source, /function initSidebarSectionCollapses\(\)/,
  'Sidebar section collapse setup is missing');
assert.match(source, /setSidebarSectionExpanded\(section, false\);/,
  'Sidebar sections must start collapsed');
assert.match(source, /function showDashboardQuickAddMenu\(\)/,
  'Dashboard quick add menu is missing');
assert.match(source, /Payment Received/, 'Quick add menu must include payment received');
assert.match(source, /Delivery Challan/, 'Quick add menu must include delivery challans');
assert.match(source, /Sales Mix/, 'Dashboard sales mix chart is missing');
assert.match(source, /conic-gradient/, 'Dashboard must render a pie chart');
assert.match(source, /function renderReportCentre\(\)/, 'Owner report centre is missing');
assert.match(source, /function renderCollections\(\)/, 'Collections and ageing workbench is missing');
assert.match(source, /downloadReportExport/, 'Report CSV export action is missing');
assert.match(source, /function showStockCountStartModal\(\)/, 'Physical stock-count workflow is missing');
assert.match(source, /function runBackupRestoreDrill\(\)/, 'Recorded backup restore drill action is missing');
assert.match(styles, /\.nav-section\.is-collapsed > \.nav-item/, 'Collapsed sidebar styling is missing');
assert.match(styles, /\.dashboard-pie/, 'Dashboard pie chart styling is missing');
console.log('Dashboard collapse, quick-add, and chart tests passed');
