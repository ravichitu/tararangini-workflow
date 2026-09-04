const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-2.4.0.js'), 'utf8');

assert.match(
  source,
  /'job-new'\s*\]\);/,
  'New job entry must be included in the protected draft-page set.'
);
assert.match(
  source,
  /if \(DRAFT_PAGES\.has\(APP_STATE\.currentPage\)\) \{\s*toast\('Data synced from another computer\. Your current draft was preserved\.'/,
  'Remote sync must keep a protected draft page in place instead of navigating away.'
);

console.log('New-job sync draft regression test passed');
