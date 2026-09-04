const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-2.4.0.js'), 'utf8');

assert.match(
  source,
  /'job-detail': \(\) => ACTIVE_JOB_ID \? openJob\(ACTIVE_JOB_ID\) : renderJobs\(\)/,
  'A sync refresh must reopen the active job detail instead of rendering the fallback page.'
);
assert.match(
  source,
  /'job-detail': 'Job Detail'/,
  'Job detail must retain its page title when it is refreshed.'
);

console.log('Job-detail sync refresh regression test passed');
