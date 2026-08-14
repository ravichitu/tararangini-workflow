const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.job-workflow-test');
const port = 3225;
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

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const operator = await request('POST', '/auth/login', { username: 'operator1', password: 'operator123' });
    const restrictedUser = await request('POST', '/auth/users', {
      name: 'Restricted Counter', username: 'restricted-counter', pin: '4567', role: 'counter', org_access: []
    }, owner.token);
    assert.strictEqual(restrictedUser.success, true);
    const restricted = await request('POST', '/auth/login', { username: 'restricted-counter', pin: '4567' });
    const restrictedOwnerUser = await request('POST', '/auth/users', {
      name: 'Restricted Owner', username: 'restricted-owner', pin: '5678', role: 'owner', org_access: [1]
    }, owner.token);
    assert.strictEqual(restrictedOwnerUser.success, true);
    const restrictedOwner = await request('POST', '/auth/login', { username: 'restricted-owner', pin: '5678' });
    await request('GET', '/advanced/integrity?org_id=1', undefined, restrictedOwner.token, 403);
    await request('GET', '/advanced/network-status', undefined, restrictedOwner.token, 403);
    await request('GET', '/advanced/update-status', undefined, restrictedOwner.token, 403);
    await request('GET', '/advanced/dsc/status', undefined, restrictedOwner.token, 403);
    await request('POST', '/advanced/encrypted-backup', { password: 'restricted-backup-password' }, restrictedOwner.token, 403);
    const restrictedSchedules = await request('GET', '/advanced/report-schedules?org_id=1', undefined, restrictedOwner.token);
    assert.strictEqual(restrictedSchedules.smtp, null);
    await request('PUT', '/advanced/report-schedules/smtp', { host: 'restricted.example.test' }, restrictedOwner.token, 403);
    await request('POST', '/advanced/maintenance', {}, restrictedOwner.token, 403);
    const restrictedPerformance = await request('GET', '/advanced/performance?org_id=1', undefined, restrictedOwner.token);
    assert.strictEqual(restrictedPerformance.scope, 1);
    assert.strictEqual(restrictedPerformance.database, null);
    assert.strictEqual(restrictedPerformance.process, null);
    assert.strictEqual(restrictedPerformance.attachment_analysis, null);
    await request('POST', '/advanced/registered-devices', {
      org_id: 1, device_id: 'DEV-JOB-SYNC-001', device_name: 'Job Workflow Sync Device'
    }, owner.token, 201);
    const customer = await request('POST', '/parties', {
      org_id: 1, type: 'customer', name: 'Job Workflow Customer',
      phone: '9000000001', email: 'job@example.test'
    }, owner.token);
    const materialItem = await request('POST', '/items', {
      org_id: 1,
      name: 'Binding Glue',
      hsn_code: '35061000',
      unit: 'NOS',
      opening_stock: 25,
      last_purchase_price: 18,
      last_sale_price: 30
    }, owner.token);
    const baseCatalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.ok(baseCatalog.services.length >= 7);
    const computerCategory = await request('POST', '/jobs/catalog/categories', {
      org_id: 1, code: 'TEST-COMPUTER', name: 'Test Computer'
    }, owner.token);
    const laptopSubcategory = await request('POST', '/jobs/catalog/subcategories', {
      org_id: 1, category_id: computerCategory.id, code: 'TEST-COMPUTER-LAPTOP', name: 'Laptop'
    }, owner.token);
    const laptopRepair = await request('POST', '/jobs/catalog/services', {
      org_id: 1, category_id: computerCategory.id, subcategory_id: laptopSubcategory.id,
      code: 'TEST-COMPUTER-LAPTOP-REPAIR', name: 'Laptop Repair', default_unit: 'NOS'
    }, owner.token);
    const catalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.strictEqual(catalog.services.length, baseCatalog.services.length + 1);
    assert.ok(catalog.subcategories.some(row => Number(row.id) === Number(laptopSubcategory.id) && Number(row.category_id) === Number(computerCategory.id)));
    assert.ok(catalog.services.some(row => Number(row.id) === Number(laptopRepair.id) && Number(row.subcategory_id) === Number(laptopSubcategory.id)));

    const created = await request('POST', '/jobs', {
      org_id: 1,
      party_id: customer.id,
      priority: 'HIGH',
      promised_delivery_at: '2026-06-13T18:00:00.000Z',
      customer_commitment: 'Match the approved sample.',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Hard binding',
        specifications: { size: 'A4', color: 'Blue' },
        quantity: 2,
        unit: 'BOOKS'
      }],
      estimate_lines: [{
        description: 'Hard binding',
        quantity: 2,
        unit: 'BOOKS',
        unit_price: 250,
        tax_rate: 0,
        line_total: 500
      }]
    }, owner.token);
    assert.match(created.token, /^JOB-/);
    assert.strictEqual(created.job.finance.estimate.total_paise, 50000);
    assert.strictEqual(created.job.finance.production_summary.estimate_paise, 50000);
    assert.strictEqual(created.job.finance.production_summary.materials_cost_paise, 0);
    assert.strictEqual(created.job.finance.production_summary.projected_margin_paise, 50000);
    assert.strictEqual(created.job.owner_work_order.work_order_id, created.token);
    assert.strictEqual(created.job.owner_work_order.customer_request, 'Match the approved sample.');
    assert.strictEqual(created.job.owner_work_order.estimate.lines[0].description, 'Hard binding');

    const consent = await request('POST', '/jobs/consents', {
      org_id: 1, party_id: customer.id,
      purpose: 'TRANSACTIONAL',
      consent_status: 'OPTED_IN',
      source: 'COUNTER_FORM',
      evidence: 'Customer approved job-status WhatsApp updates.'
    }, owner.token);
    assert.strictEqual(consent.success, true);
    const communicationStatus = await request('GET', `/jobs/${created.id}/communication-status`, undefined, owner.token);
    assert.strictEqual(communicationStatus.whatsapp_transactional_consent, true);
    assert.strictEqual(communicationStatus.consent.source, 'COUNTER_FORM');
    await request('GET', `/jobs/${created.id}`, undefined, restricted.token, 403);
    await request('GET', `/jobs/${created.id}/communication-status`, undefined, restricted.token, 403);
    await request('GET', `/jobs/${created.id}/messages`, undefined, restricted.token, 403);
    await request('POST', '/jobs/consents', {
      org_id: 1, party_id: customer.id, purpose: 'TRANSACTIONAL', consent_status: 'OPTED_IN',
      source: 'COUNTER_FORM', evidence: 'This request must be denied.'
    }, restricted.token, 403);
    const externalOpen = await request('POST', `/jobs/${created.id}/messages/presented`, {
      body_text: 'Your job status is waiting for production.',
      template_code: 'JOB_STATUS_EXTERNAL_WHATSAPP'
    }, owner.token, 201);
    assert.strictEqual(externalOpen.delivery_status, 'OPENED_EXTERNALLY');
    const communications = await request('GET', `/jobs/${created.id}/messages`, undefined, owner.token);
    assert.strictEqual(communications.messages.length, 1);
    assert.strictEqual(communications.messages[0].delivery_status, 'OPENED_EXTERNALLY');
    assert.strictEqual(communications.messages[0].sent_at, null);

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn9xJgAAAAASUVORK5CYII=';
    const attachment = await request('POST', `/jobs/${created.id}/attachments`, {
      file_name: 'binding-reference.png',
      mime_type: 'image/png',
      content_base64: pngBase64
    }, owner.token);
    assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(attachment.pixel_width, 1);
    assert.strictEqual(attachment.pixel_height, 1);
    assert.strictEqual(attachment.analysis_status, 'READY');

    const secondOrg = await request('POST', '/orgs', {
      display_name: 'Attachment Scope Test', registered_name: 'Attachment Scope Test', gst_type: 'regular'
    }, owner.token);
    const secondCustomer = await request('POST', '/parties', {
      org_id: secondOrg.id, type: 'customer', name: 'Second Company Customer', phone: '9000000002'
    }, owner.token);
    const secondCategory = await request('POST', '/jobs/catalog/categories', {
      org_id: secondOrg.id, code: 'SCOPE-PRINT', name: 'Scope Print'
    }, owner.token);
    const secondSubcategory = await request('POST', '/jobs/catalog/subcategories', {
      org_id: secondOrg.id, category_id: secondCategory.id, code: 'SCOPE-PRINT-A4', name: 'A4 Printing'
    }, owner.token);
    const secondService = await request('POST', '/jobs/catalog/services', {
      org_id: secondOrg.id, category_id: secondCategory.id, subcategory_id: secondSubcategory.id,
      code: 'SCOPE-PRINT-A4-COLOUR', name: 'A4 Colour Print', default_unit: 'PAGES'
    }, owner.token);
    const secondJob = await request('POST', '/jobs', {
      org_id: secondOrg.id,
      party_id: secondCustomer.id,
      priority: 'NORMAL', promised_delivery_at: '2026-06-15T18:00:00.000Z',
      items: [{ service_id: secondService.id, description: 'Second-company attachment test', quantity: 1, unit: 'PAGES' }],
      estimate_lines: [{ description: 'A4 Colour Print', quantity: 1, unit: 'PAGES', unit_price: 10, tax_rate: 0, line_total: 10 }]
    }, owner.token);
    await request('POST', `/jobs/${secondJob.id}/attachments`, {
      file_name: 'second-company-reference.png', mime_type: 'image/png', content_base64: pngBase64
    }, owner.token);
    const firstOrgPerformance = await request('GET', '/advanced/performance?org_id=1', undefined, owner.token);
    const secondOrgPerformance = await request('GET', `/advanced/performance?org_id=${secondOrg.id}`, undefined, owner.token);
    assert.strictEqual(Number(firstOrgPerformance.records.attachments), 1);
    assert.strictEqual(Number(secondOrgPerformance.records.attachments), 1);

    const productionList = await request('GET', '/jobs?org_id=1', undefined, operator.token);
    const productionJob = productionList.find(job => job.id === created.id);
    assert.ok(productionJob);
    assert.strictEqual(productionJob.finance, undefined);
    assert.match(productionJob.customer.reference, /^C-/);
    assert.strictEqual(productionJob.customer.name, undefined);
    assert.strictEqual(productionJob.primary_item.description, 'Hard binding');
    assert.strictEqual(productionJob.primary_item.quantity, 2);
    assert.strictEqual(productionJob.primary_item.unit, 'BOOKS');
    const productionDetail = await request('GET', `/jobs/${created.id}`, undefined, operator.token);
    const createdAttachment = productionDetail.attachments.find(file => file.file_name === 'binding-reference.png');
    assert.ok(createdAttachment);
    assert.strictEqual(createdAttachment.content_base64, undefined);
    assert.strictEqual(createdAttachment.pixel_width, 1);
    assert.strictEqual(createdAttachment.pixel_height, 1);

    const hiddenStaffUpload = await request('POST', `/jobs/${created.id}/attachments`, {
      file_name: 'internal-proof.png',
      mime_type: 'image/png',
      content_base64: pngBase64,
      visible_to_customer: false
    }, owner.token);
    assert.strictEqual(hiddenStaffUpload.analysis_status, 'READY');

    const preBillJob = await request('POST', '/jobs', {
      org_id: 1,
      party_id: customer.id,
      priority: 'NORMAL',
      promised_delivery_at: '2026-06-14T18:00:00.000Z',
      customer_commitment: 'Pre-billed simple job.',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Pre-billed binding',
        specifications: { size: 'A5' },
        quantity: 1,
        unit: 'BOOKS'
      }],
      estimate_lines: [{
        description: 'Pre-billed binding',
        quantity: 1,
        unit: 'BOOKS',
        unit_price: 120,
        tax_rate: 0,
        line_total: 120
      }]
    }, owner.token);
    const firstBill = await request('POST', `/jobs/${preBillJob.id}/pre-bill`, {
      payment_mode: 'credit'
    }, owner.token);
    assert.ok(firstBill.bill_id);
    assert.strictEqual(firstBill.total, 120);
    assert.strictEqual(firstBill.job.finance.pre_bill.id, firstBill.bill_id);
    const preBillAssignment = await request('POST', `/jobs/${preBillJob.id}/assign`, {
      employee_id: operator.user.id,
      handoff_type: 'INITIAL_ASSIGNMENT',
      reason: 'Assign pre-billed work'
    }, owner.token);
    await request('POST', `/jobs/assignments/${preBillAssignment.id}/respond`, {
      decision: 'ACCEPT'
    }, operator.token);
    for (const status of ['IN_PROGRESS', 'QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY']) {
      await request('POST', `/jobs/${preBillJob.id}/status`, {
        status, reason: `Pre-bill job to ${status}`
      }, operator.token);
    }
    const preBillDelivery = await request('POST', `/jobs/${preBillJob.id}/deliver`, {
      receiver_name: 'Workflow Customer',
      acknowledgement_method: 'OTP',
      service_notes: 'Delivered against first bill.',
      warranty_notes: ''
    }, owner.token);
    assert.strictEqual(preBillDelivery.bill_id, firstBill.bill_id);
    assert.strictEqual(preBillDelivery.reused_pre_bill, true);
    assert.strictEqual(preBillDelivery.outstanding, 120);

    const assigned = await request('POST', `/jobs/${created.id}/assign`, {
      employee_id: operator.user.id,
      handoff_type: 'INITIAL_ASSIGNMENT',
      reason: 'Assign binding work'
    }, owner.token);
    await request('POST', `/jobs/assignments/${assigned.id}/respond`, {
      decision: 'ACCEPT'
    }, operator.token);
    const consumed = await request('POST', `/jobs/${created.id}/materials`, {
      item_id: materialItem.id,
      quantity: 3,
      notes: 'Glue used for final spine binding.'
    }, operator.token);
    assert.strictEqual(consumed.material.item_name_snapshot, 'Binding Glue');
    assert.strictEqual(consumed.stock_warnings.length, 0);
    const beforeReport = await request('GET', `/jobs/${created.id}`, undefined, owner.token);
    await request('POST', `/jobs/${created.id}/reports`, {
      report_type: 'PROGRESS',
      progress_percent: 35,
      report_text: 'Binding started and cover alignment checked.'
    }, operator.token);
    const staleChange = await request('POST', `/jobs/${created.id}/status`, {
      status: 'IN_PROGRESS', reason: 'Offline stale transition',
      offline_change_id: 'JOB-CHANGE-STALE-001', base_version: beforeReport.version,
      offline_device_id: 'DEV-JOB-SYNC-001'
    }, operator.token, 409, { 'x-tarangini-device-id': 'DEV-JOB-SYNC-001' });
    assert.strictEqual(staleChange.code, 'SYNC_VERSION_CONFLICT');
    const currentJob = await request('GET', `/jobs/${created.id}`, undefined, owner.token);
    const syncedTransition = await request('POST', `/jobs/${created.id}/status`, {
      status: 'IN_PROGRESS', reason: 'Offline synchronized transition',
      offline_change_id: 'JOB-CHANGE-CURRENT-001', base_version: currentJob.version,
      offline_device_id: 'DEV-JOB-SYNC-001'
    }, operator.token, 200, { 'x-tarangini-device-id': 'DEV-JOB-SYNC-001' });
    assert.strictEqual(syncedTransition.idempotent, undefined);
    const replayTransition = await request('POST', `/jobs/${created.id}/status`, {
      status: 'IN_PROGRESS', reason: 'Offline synchronized transition replay',
      offline_change_id: 'JOB-CHANGE-CURRENT-001', base_version: currentJob.version,
      offline_device_id: 'DEV-JOB-SYNC-001'
    }, operator.token, 200, { 'x-tarangini-device-id': 'DEV-JOB-SYNC-001' });
    assert.strictEqual(replayTransition.idempotent, true);
    for (const status of ['QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY']) {
      await request('POST', `/jobs/${created.id}/status`, {
        status, reason: `Move to ${status}`
      }, operator.token);
    }

    const addition = await request('POST', `/jobs/${created.id}/additions`, {
      reason: 'Protective cover required',
      attachments: [{
        file_name: 'cover-damage.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('evidence image bytes').toString('base64')
      }]
    }, operator.token);
    const additionEvidence = await request('GET', `/jobs/${created.id}`, undefined, operator.token);
    assert.ok(additionEvidence.attachments.some(file =>
      file.entity_type === 'ADDITION' && file.file_name === 'cover-damage.jpg'));
    await request('PUT', `/jobs/additions/${addition.id}/price`, {
      customer_description: 'Protective cover',
      quantity: 2,
      unit: 'NOS',
      unit_price: 50,
      tax_rate: 0
    }, owner.token);
    const customerAccess = await request('POST', `/jobs/${created.id}/customer-access`, {
      valid_days: 7
    }, owner.token);
    const customerView = await request('GET', `/job-portal/${customerAccess.token}`);
    assert.strictEqual(customerView.job_token, created.token);
    assert.strictEqual(customerView.additions[0].state, 'AWAITING_CUSTOMER');
    assert.strictEqual(customerView.attachments.some(file => file.file_name === 'internal-proof.png'), false);
    assert.strictEqual(customerView.quotation.lines[0].description, 'Hard binding');
    assert.strictEqual(customerView.quotation.total_paise, 50000);

    const hiddenPortalContent = await fetch(`http://127.0.0.1:${port}/api/job-portal/${customerAccess.token}/attachments/${hiddenStaffUpload.id}/content`);
    assert.strictEqual(hiddenPortalContent.status, 404);

    const staffContent = await fetch(`http://127.0.0.1:${port}/api/jobs/attachments/${hiddenStaffUpload.id}/content`, {
      headers: { Authorization: `Bearer ${owner.token}` }
    });
    assert.strictEqual(staffContent.status, 200);

    await request('PATCH', `/jobs/attachments/${hiddenStaffUpload.id}`, {
      visible_to_customer: true
    }, owner.token);

    const sharedPortalView = await request('GET', `/job-portal/${customerAccess.token}`);
    const sharedStaffUpload = sharedPortalView.attachments.find(file => file.file_name === 'internal-proof.png');
    assert.ok(sharedStaffUpload);
    assert.strictEqual(sharedStaffUpload.pixel_width, 1);
    assert.strictEqual(sharedStaffUpload.pixel_height, 1);

    const imageUpload = await request('POST', `/job-portal/${customerAccess.token}/uploads`, {
      file_name: 'proof.png',
      mime_type: 'image/png',
      content_base64: pngBase64,
      purpose: 'CUSTOMER_UPLOAD'
    });
    assert.strictEqual(imageUpload.attachment.pixel_width, 1);
    assert.strictEqual(imageUpload.attachment.pixel_height, 1);
    assert.strictEqual(imageUpload.attachment.analysis_status, 'READY');

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = Buffer.from(await pdfDoc.save());
    const analyzedPortalPdf = await request('POST', `/job-portal/${customerAccess.token}/analyze-upload`, {
      file_name: 'portal-analyze.pdf',
      mime_type: 'application/pdf',
      content_base64: pdfBytes.toString('base64')
    });
    assert.strictEqual(analyzedPortalPdf.analysis.pdf_page_count, 2);
    assert.strictEqual(analyzedPortalPdf.analysis.metadata.uniform_page_size, 'A4');
    const pdfUpload = await request('POST', `/job-portal/${customerAccess.token}/uploads`, {
      file_name: 'instructions.pdf',
      mime_type: 'application/pdf',
      content_base64: pdfBytes.toString('base64'),
      purpose: 'CUSTOMER_REFERENCE',
      customer_pdf_print_request: {
        colour_print_active: true,
        customer_confirmed_total_pages: 2,
        customer_confirmed_color_pages: 1,
        customer_confirmed_bw_pages: 1,
        customer_page_confirmation: true,
        confirmation_notes: 'First page colour, second page B/W'
      }
    });
    assert.strictEqual(pdfUpload.attachment.pdf_page_count, 2);
    assert.strictEqual(pdfUpload.attachment.analysis_status, 'READY');
    assert.strictEqual(pdfUpload.attachment.metadata.uniform_page_size, 'A4');
    assert.strictEqual(pdfUpload.attachment.metadata.customer_print_request.customer_confirmed_color_pages, 1);
    assert.strictEqual(pdfUpload.attachment.metadata.customer_print_request.customer_confirmed_bw_pages, 1);

    const portalAfterUploads = await request('GET', `/job-portal/${customerAccess.token}`);
    const uploadedImage = portalAfterUploads.attachments.find(file => file.file_name === 'proof.png');
    const uploadedPdf = portalAfterUploads.attachments.find(file => file.file_name === 'instructions.pdf');
    assert.strictEqual(uploadedImage.pixel_width, 1);
    assert.strictEqual(uploadedImage.pixel_height, 1);
    assert.strictEqual(uploadedPdf.pdf_page_count, 2);
    assert.strictEqual(uploadedPdf.metadata.uniform_page_size, 'A4');
    assert.strictEqual(uploadedPdf.metadata.customer_print_request.customer_confirmed_color_pages, 1);
    assert.strictEqual(uploadedPdf.metadata.customer_print_request.customer_page_confirmation, true);

    const ownerViewAfterPdf = await request('GET', `/jobs/${created.id}`, undefined, owner.token);
    assert.strictEqual(
      ownerViewAfterPdf.attachments.find(file => file.file_name === 'instructions.pdf').metadata.customer_print_request.customer_confirmed_bw_pages,
      1
    );
    assert.strictEqual(ownerViewAfterPdf.materials[0].item_name_snapshot, 'Binding Glue');
    assert.strictEqual(ownerViewAfterPdf.owner_work_order.materials[0].notes, 'Glue used for final spine binding.');
    assert.strictEqual(ownerViewAfterPdf.finance.production_summary.estimate_paise, 50000);
    assert.strictEqual(ownerViewAfterPdf.finance.production_summary.approved_additions_paise, 0);
    assert.strictEqual(ownerViewAfterPdf.finance.production_summary.materials_cost_paise, 5400);
    assert.strictEqual(ownerViewAfterPdf.finance.production_summary.projected_margin_paise, 44600);
    assert.strictEqual(ownerViewAfterPdf.owner_work_order.commercial_summary.material_entries, 1);
    assert.strictEqual(ownerViewAfterPdf.owner_work_order.counter_note || '', '');
    assert.strictEqual(ownerViewAfterPdf.owner_work_order.work_reports[0].report_text, 'Binding started and cover alignment checked.');
    assert.strictEqual(ownerViewAfterPdf.owner_work_order.estimate.lines[0].description, 'Hard binding');
    assert.ok(ownerViewAfterPdf.owner_work_order.timeline.some(event => event.to_status === 'READY_FOR_DELIVERY'));
    const stockMovements = await request('GET', `/business/stock/${materialItem.id}/movements?org_id=1`, undefined, owner.token);
    const materialMovement = stockMovements.find(row =>
      row.source_type === 'job_material' && Number(row.source_id) === Number(consumed.material.id));
    assert.ok(materialMovement);
    assert.strictEqual(Number(materialMovement.qty_out), 3);

    const blockedReopen = await request('POST', `/jobs/${created.id}/status`, {
      status: 'IN_PROGRESS',
      reason: 'Operator wants to change ready job'
    }, operator.token, 403);
    assert.match(blockedReopen.error, /Owner or Senior Operator/);
    const ownerReopen = await request('POST', `/jobs/${created.id}/status`, {
      status: 'IN_PROGRESS',
      reason: 'Customer requested one correction before delivery'
    }, owner.token);
    assert.strictEqual(ownerReopen.job.current_status, 'IN_PROGRESS');
    for (const status of ['QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY']) {
      await request('POST', `/jobs/${created.id}/status`, {
        status,
        reason: `Correction reviewed to ${status}`
      }, owner.token);
    }

    const pdfContent = await fetch(`http://127.0.0.1:${port}/api/job-portal/${customerAccess.token}/attachments/${uploadedPdf.id}/content`);
    const pdfBuffer = Buffer.from(await pdfContent.arrayBuffer());
    assert.strictEqual(pdfContent.status, 200);
    assert.strictEqual(pdfBuffer.length, pdfBytes.length);

    await request('POST', `/job-portal/${customerAccess.token}/additions/${addition.id}/decision`, {
      decision: 'APPROVED',
      method: 'DIGITAL_SIGNATURE',
      approver_name: 'Workflow Customer',
      signature_data: 'Workflow Customer',
      confirmation_text: 'I approve the additional protective cover.'
    });

    const delivered = await request('POST', `/jobs/${created.id}/deliver`, {
      receiver_name: 'Workflow Customer',
      acknowledgement_method: 'OTP',
      service_notes: 'Final trim and binding completed as requested.',
      warranty_notes: 'Binding workmanship warranty: 7 days.',
      payments: [
        { mode: 'cash', amount: 200 },
        { mode: 'upi', amount: 400, reference: 'UPI-JOB-001' }
      ]
    }, owner.token);
    assert.ok(delivered.bill_id);
    assert.strictEqual(delivered.outstanding, 0);
    assert.strictEqual(delivered.receipt_ids.length, 2);
    assert.strictEqual(delivered.job.current_status, 'DELIVERED');
    assert.strictEqual(delivered.job.finance.financial_status, 'PAID');
    assert.strictEqual(delivered.job.finance.production_summary.approved_additions_paise, 10000);
    assert.strictEqual(delivered.job.finance.production_summary.projected_revenue_paise, 60000);
    assert.strictEqual(delivered.job.finance.production_summary.final_invoice_paise, 60000);
    assert.strictEqual(delivered.job.finance.production_summary.final_margin_paise, 54600);
    assert.strictEqual(delivered.job.owner_work_order.delivery.service_notes, 'Final trim and binding completed as requested.');
    assert.strictEqual(delivered.job.owner_work_order.delivery.warranty_notes, 'Binding workmanship warranty: 7 days.');

    const portalAfterDelivery = await request('GET', `/job-portal/${customerAccess.token}`);
    assert.strictEqual(portalAfterDelivery.final_bill_number, delivered.bill_number);
    assert.strictEqual(portalAfterDelivery.financial_status, 'PAID');

    const bill = await request('GET', `/bills/${delivered.bill_id}/full`, undefined, owner.token);
    assert.strictEqual(bill.grand_total, 600);
    assert.strictEqual(bill.custom_data.includes(created.token), true);
    assert.strictEqual(bill.payment_status, 'paid');

    const lockedReport = await request('POST', `/jobs/${created.id}/reports`, {
      report_text: 'Late edit after delivery should not be accepted.'
    }, operator.token, 423);
    assert.strictEqual(lockedReport.locked, true);

    const lockedMaterial = await request('POST', `/jobs/${created.id}/materials`, {
      item_id: materialItem.id,
      quantity: 1,
      notes: 'Late material edit should not be accepted.'
    }, operator.token, 423);
    assert.strictEqual(lockedMaterial.locked, true);

    const lockedAttachment = await request('POST', `/jobs/${created.id}/attachments`, {
      file_name: 'late-proof.txt',
      mime_type: 'text/plain',
      content_base64: Buffer.from('late edit').toString('base64')
    }, owner.token, 423);
    assert.strictEqual(lockedAttachment.locked, true);

    const audit = await request('GET', `/jobs/${created.id}/audit`, undefined, owner.token);
    assert.ok(audit.some(event => event.action === 'DELIVER'));
    assert.ok(audit.some(event => event.action === 'APPROVED'));
    assert.ok(audit.some(event => event.actor_role === 'CUSTOMER'));

    const reset = await request('POST', '/jobs/catalog/reset', {
      org_id: 1,
      confirmation: 'RESET SERVICE CATALOG',
      reason: 'Integration test fresh catalog'
    }, owner.token);
    assert.strictEqual(reset.success, true);
    assert.ok(reset.archived.services >= 1);
    const emptyCatalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.strictEqual(emptyCatalog.categories.length, 0);
    assert.strictEqual(emptyCatalog.subcategories.length, 0);
    assert.strictEqual(emptyCatalog.services.length, 0);
    const rebuiltCategory = await request('POST', '/jobs/catalog/categories', {
      org_id: 1, code: 'BIND', name: 'Finishing Services'
    }, owner.token);
    assert.ok(rebuiltCategory.reactivated);
    const preservedJob = await request('GET', `/jobs/${created.id}`, undefined, owner.token);
    assert.strictEqual(preservedJob.current_status, 'DELIVERED');
    console.log('Job workflow integration tests passed');
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
