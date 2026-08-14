const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.job-intake-test');
const port = 3226;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${output}`);
}

async function request(method, route, body, token, expected = 200, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.strictEqual(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function multipartRequest(payload, files) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  files.forEach(file => form.append('attachment', new Blob([file.bytes], { type: file.mime_type }), file.file_name));
  const response = await fetch(`http://127.0.0.1:${port}/api/job-intake/submit-multipart`, { method: 'POST', body: form });
  const body = await response.json();
  assert.strictEqual(response.status, 200, JSON.stringify(body));
  return body;
}

function simplePdfWithContent(content) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

(async () => {
  try {
    await waitForServer();
    const health = await request('GET', '/health');
    assert.strictEqual(health.deployment_profile.target_concurrent_customers, 200);
    assert.strictEqual(health.deployment_profile.channels_ready.android_pwa, true);

    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const operator = await request('POST', '/auth/login', { username: 'operator1', password: 'operator123' });
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn9xJgAAAAASUVORK5CYII=';

    const config = await request('GET', '/job-intake/config?org_id=1');
    assert.strictEqual(config.org.id, 1);
    assert.ok(Array.isArray(config.service_groups));
    assert.ok(config.service_groups.length >= 1);
    assert.ok(config.service_groups[0].services.length >= 1);

    const link = await request('GET', '/job-intake/link?org_id=1', undefined, owner.token);
    assert.match(link.url, /customer-intake\.html\?org=1$/);
    assert.match(link.qr_data_url, /^data:image\/png;base64,/);

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = Buffer.from(await pdfDoc.save());

    const analyzedPdf = await request('POST', '/job-intake/analyze-file', {
      file_name: 'analyze-before-submit.pdf',
      mime_type: 'application/pdf',
      content_base64: pdfBytes.toString('base64')
    });
    assert.strictEqual(analyzedPdf.analysis.pdf_page_count, 2);
    assert.strictEqual(analyzedPdf.analysis.metadata.uniform_page_size, 'A4');
    assert.strictEqual(analyzedPdf.analysis.metadata.has_mixed_page_sizes, false);
    assert.strictEqual(analyzedPdf.analysis.metadata.auto_detected_colour_pages, 0);

    const analyzedColourPdf = await request('POST', '/job-intake/analyze-file', {
      file_name: 'colour-proof.pdf',
      mime_type: 'application/pdf',
      content_base64: simplePdfWithContent('1 0 0 rg\n0 0 100 100 re\nf').toString('base64')
    });
    assert.strictEqual(analyzedColourPdf.analysis.pdf_page_count, 1);
    assert.strictEqual(analyzedColourPdf.analysis.metadata.colour_detection.detected, true);
    assert.strictEqual(analyzedColourPdf.analysis.metadata.auto_detected_colour_pages, 1);

    await request('POST', '/job-intake/submit', {
      org_id: 1,
      customer_name: 'Consent Missing Customer',
      customer_phone: '9000000014',
      issue_summary: 'Should not submit without confirmation'
    }, undefined, 400);

    const intake = await request('POST', '/job-intake/submit', {
      org_id: 1,
      customer_name: 'Portal Customer',
      customer_phone: '9000000015',
      customer_email: 'portal@example.test',
      customer_address: 'Customer street',
      preferred_contact: 'WHATSAPP',
      item_type: 'Laptop',
      item_name: 'HP Laptop',
      device_brand: 'HP',
      device_model: '15s',
      device_serial: 'HP-001',
      quantity: 1,
      issue_summary: 'Laptop keyboard and print alignment issue',
      issue_details: 'Need checking before final print and binding',
      requested_delivery_at: '2026-06-25T10:30',
      consent_status: true,
      consent_text: 'Customer confirmed',
      attachments: [
        {
          file_name: 'evidence.png',
          mime_type: 'image/png',
          content_base64: pngBase64
        },
        {
          file_name: 'instructions.pdf',
          mime_type: 'application/pdf',
          content_base64: pdfBytes.toString('base64'),
          customer_pdf_print_request: {
            colour_print_active: true,
            customer_confirmed_total_pages: 2,
            customer_confirmed_color_pages: 1,
            customer_confirmed_bw_pages: 1,
            customer_page_confirmation: true,
            confirmation_notes: 'Front page colour, remaining black and white'
          }
        }
      ]
    }, undefined, 200, { 'x-idempotency-key': 'public-intake-001' });
    assert.match(intake.request_number, /^INQ-/);
    assert.strictEqual(intake.order_id, intake.request_number);
    assert.strictEqual(intake.attachment_count, 2);

    const savedCustomer = await request('GET', '/job-intake/customer-profile?org_id=1&phone=%2B91%2090000-00015');
    assert.strictEqual(savedCustomer.found, true);
    assert.strictEqual(savedCustomer.customer.name, 'Portal Customer');
    assert.strictEqual(savedCustomer.customer.email, 'portal@example.test');
    assert.strictEqual(savedCustomer.customer.address, 'Customer street');
    const missingCustomer = await request('GET', '/job-intake/customer-profile?org_id=1&phone=9000000088');
    assert.strictEqual(missingCustomer.found, false);

    const repeatedCustomer = await request('POST', '/job-intake/submit', {
      org_id: 1,
      client_request_id: 'public-intake-repeat-phone-001',
      customer_name: 'Portal Customer',
      customer_phone: '+91 90000-00015',
      issue_summary: 'Repeat customer test order',
      consent_status: true,
      consent_text: 'Customer confirmed repeat request'
    });
    assert.strictEqual(Number(repeatedCustomer.party_id), Number(intake.party_id));

    const statusBeforeConversion = await request('GET',
      `/job-intake/status?org_id=1&order_id=${encodeURIComponent(intake.order_id)}&phone=9000000015`);
    assert.strictEqual(statusBeforeConversion.order_id, intake.order_id);
    assert.strictEqual(statusBeforeConversion.request_status, 'SUBMITTED');
    assert.strictEqual(statusBeforeConversion.job, null);
    assert.strictEqual(statusBeforeConversion.billing_party_linked, true);
    assert.ok(Number(statusBeforeConversion.party_id) > 0);

    const duplicate = await request('POST', '/job-intake/submit', {
      org_id: 1,
      customer_name: 'Portal Customer',
      customer_phone: '9000000015',
      issue_summary: 'Laptop keyboard and print alignment issue'
    }, undefined, 200, { 'x-idempotency-key': 'public-intake-001' });
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.request_number, intake.request_number);
    assert.strictEqual(duplicate.attachment_count, 2);

    const intakeList = await request('GET', '/job-intake?org_id=1', undefined, owner.token);
    assert.strictEqual(intakeList.requests.length, 2);
    assert.strictEqual(intakeList.requests[0].status, 'SUBMITTED');

    const detail = await request('GET', `/job-intake/${intake.id}`, undefined, owner.token);
    assert.strictEqual(detail.customer_name, 'Portal Customer');
    assert.ok(Number(detail.party_id) > 0);
    assert.strictEqual(detail.attachments.length, 2);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'evidence.png').pixel_width, 1);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'evidence.png').pixel_height, 1);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'instructions.pdf').pdf_page_count, 2);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'instructions.pdf').metadata.uniform_page_size, 'A4');
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_confirmed_color_pages, 1);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_confirmed_bw_pages, 1);
    assert.strictEqual(detail.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_page_confirmation, true);

    const zipResponse = await fetch(`http://127.0.0.1:${port}/api/job-intake/${intake.id}/attachments.zip`, {
      headers: { Authorization: `Bearer ${owner.token}` }
    });
    const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
    assert.strictEqual(zipResponse.status, 200);
    assert.strictEqual(zipResponse.headers.get('content-type'), 'application/zip');
    assert.strictEqual(zipBytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(zipBytes.includes(Buffer.from('evidence.png')));
    assert.ok(zipBytes.includes(Buffer.from('instructions.pdf')));

    await request('PATCH', `/job-intake/${intake.id}`, {
      status: 'REVIEWED',
      internal_notes: 'Checked by counter'
    }, owner.token);

    const catalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.ok(catalog.services.length >= 1);

    const converted = await request('POST', `/job-intake/${intake.id}/convert`, {
      service_id: catalog.services[0].id,
      priority: 'HIGH',
      quantity: 1,
      unit: catalog.services[0].default_unit || 'NOS',
      promised_delivery_at: '2026-06-26T18:00',
      description: 'Laptop keyboard service',
      customer_commitment: 'Check laptop and complete service',
      internal_notes: 'Converted by intake flow',
      estimate_unit_price: 750,
      tax_rate: 18
    }, owner.token);
    assert.match(converted.job_token, /^JOB-/);
    assert.strictEqual(Number(converted.party_id), Number(detail.party_id));

    const job = await request('GET', `/jobs/${converted.job_id}`, undefined, owner.token);
    assert.strictEqual(job.customer.name, 'Portal Customer');
    assert.ok(job.service_summary?.family_label);
    assert.strictEqual(job.finance.estimate.total_paise > 0, true);
    assert.strictEqual(job.attachments.length, 2);
    assert.strictEqual(job.attachments.find(file => file.file_name === 'evidence.png').pixel_width, 1);
    assert.strictEqual(job.attachments.find(file => file.file_name === 'instructions.pdf').pdf_page_count, 2);
    assert.strictEqual(job.attachments.find(file => file.file_name === 'instructions.pdf').metadata.uniform_page_size, 'A4');
    assert.strictEqual(job.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_confirmed_color_pages, 1);
    assert.strictEqual(job.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_confirmed_bw_pages, 1);

    const intakeAfter = await request('GET', `/job-intake/${intake.id}`, undefined, owner.token);
    assert.strictEqual(intakeAfter.status, 'CONVERTED');
    assert.strictEqual(Number(intakeAfter.converted_job_id), Number(converted.job_id));

    const statusAfterConversion = await request('GET',
      `/job-intake/status?org_id=1&order_id=${encodeURIComponent(intake.order_id)}&phone=9000000015`);
    assert.strictEqual(statusAfterConversion.request_status, 'CONVERTED');
    assert.strictEqual(statusAfterConversion.job.token, converted.job_token);
    assert.strictEqual(statusAfterConversion.job.current_status, 'WAITING');
    assert.strictEqual(statusAfterConversion.job.final_bill_number, null);
    assert.strictEqual(statusAfterConversion.quotation.lines[0].description, 'Laptop keyboard service');
    assert.strictEqual(statusAfterConversion.quotation.total_paise > 0, true);

    const assigned = await request('POST', `/jobs/${converted.job_id}/assign`, {
      employee_id: operator.user.id,
      handoff_type: 'INITIAL_ASSIGNMENT',
      reason: 'Assign intake-created job for completion'
    }, owner.token);
    await request('POST', `/jobs/assignments/${assigned.id}/respond`, {
      decision: 'ACCEPT'
    }, operator.token);

    for (const status of ['IN_PROGRESS', 'QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY']) {
      await request('POST', `/jobs/${converted.job_id}/status`, {
        status, reason: `Move to ${status}`
      }, operator.token);
    }

    const delivered = await request('POST', `/jobs/${converted.job_id}/deliver`, {
      receiver_name: 'Portal Customer',
      acknowledgement_method: 'OTP',
      warranty_notes: 'Service warranty recorded.',
      payments: [
        { mode: 'cash', amount: 885 }
      ]
    }, owner.token);
    assert.ok(delivered.bill_number);

    const statusAfterDelivery = await request('GET',
      `/job-intake/status?org_id=1&order_id=${encodeURIComponent(intake.order_id)}&phone=9000000015`);
    assert.strictEqual(statusAfterDelivery.job.current_status, 'DELIVERED');
    assert.strictEqual(statusAfterDelivery.job.final_bill_number, delivered.bill_number);
    assert.strictEqual(statusAfterDelivery.job.financial_status, 'PAID');

    const multipart = await multipartRequest({
      org_id: 1,
      client_request_id: 'multipart-intake-001',
      customer_name: 'Multipart Customer',
      customer_phone: '9000000099',
      issue_summary: 'Streaming intake upload',
      consent_status: true,
      consent_text: 'Confirmed multipart intake',
      attachments: [{ customer_pdf_print_request: null }]
    }, [{ file_name: 'multipart-proof.png', mime_type: 'image/png', bytes: Buffer.from(pngBase64, 'base64') }]);
    assert.ok(multipart.order_id);
    assert.strictEqual(multipart.attachment_count, 1);

    console.log('Job intake integration tests passed');
  } finally {
    if (!server.killed) {
      server.kill();
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
