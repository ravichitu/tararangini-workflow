const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, '.backup-source-test');
const targetDir = path.join(root, '.backup-target-test');
fs.rmSync(sourceDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function startServer(dataDir, port) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
        return { server, port, output: () => output };
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  server.kill();
  throw new Error(`Backup test server did not start:\n${output}`);
}

async function stopServer(instance) {
  if (!instance || instance.server.killed) return;
  instance.server.kill();
  await new Promise(resolve => {
    instance.server.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function request(instance, method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${instance.output()}`);
  return payload;
}

(async () => {
  let source;
  let target;
  try {
    source = await startServer(sourceDir, 3232);
    const sourceOwner = await request(source, 'POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    });
    const org = await request(source, 'POST', '/orgs', {
      display_name: 'Roundtrip Recovery Company',
      registered_name: 'Roundtrip Recovery Company Private Limited',
      gst_type: 'regular',
      invoice_theme: 'emerald',
      default_tax_inclusive: true
    }, sourceOwner.token);
    await request(source, 'POST', '/advanced/registered-devices', {
      org_id: org.id, device_id: 'DEV-BACKUP-001', device_name: 'Backup Recovery Client'
    }, sourceOwner.token, 201);
    const party = await request(source, 'POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Recovery Customer'
    }, sourceOwner.token);
    const partyAddress = await request(source, 'POST', `/parties/${party.id}/addresses`, {
      label: 'Recovery Branch Address',
      address_type: 'billing_delivery',
      contact_person: 'Recovery Manager',
      phone: '9000000001',
      address: 'Restore Street',
      city: 'Kakinada',
      district: 'Kakinada',
      state: 'Andhra Pradesh',
      pincode: '533001',
      is_default_billing: true,
      is_default_delivery: true
    }, sourceOwner.token);
    assert.ok(partyAddress.id);
    const item = await request(source, 'POST', '/items', {
      org_id: org.id, name: 'Recovery Keyboard', hsn_code: '84716040',
      item_code: 'REC-KB-01', model_number: 'K100', barcode: '890000000001',
      unit: 'NOS', gst_rate: 18, last_sale_price: 1000, opening_stock: 5,
      reorder_level: 2
    }, sourceOwner.token);
    const bill = (await request(source, 'POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-13', party_id: party.id,
      payment_mode: 'upi', tax_inclusive: true,
      delivery_info: {
        recipient_name: 'Store Manager', recipient_phone: '9000000000',
        transport_name: 'Recovery Courier', tracking_id: 'REC-LR-1',
        dispatch_date: '2026-06-13'
      },
      items: [{
        item_id: item.id, item_name: 'Recovery Keyboard',
        item_description: 'Serial REC-001', qty: 1, unit: 'NOS',
        rate: 1000, amount: 1000, gst_rate: 18
      }]
    }, sourceOwner.token)).bill;
    await request(source, 'POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-13', party_id: party.id,
      type: 'received', mode: 'upi', amount: bill.grand_total,
      reference: 'UPI-RECOVERY-1',
      linked_bills: [{ bill_id: bill.id, amount: bill.grand_total }]
    }, sourceOwner.token);
    const deliveryChallan = (await request(source, 'POST', '/bills', {
      org_id: org.id, format: 'DC', bill_date: '2026-06-14', party_id: party.id,
      billing_address_id: partyAddress.id,
      delivery_address_id: partyAddress.id,
      payment_mode: 'credit',
      items: [{
        item_id: item.id, item_name: 'Recovery Keyboard',
        item_description: 'Warranty dispatch serial REC-001', qty: 1, unit: 'NOS',
        rate: 0, amount: 0, gst_rate: 0
      }]
    }, sourceOwner.token)).bill;
    const warranty = await request(source, 'POST', '/warranty-replacements', {
      org_id: org.id,
      party_id: party.id,
      original_sale_bill_id: bill.id,
      delivery_bill_id: deliveryChallan.id,
      product_item_id: item.id,
      serial_number: 'REC-SN-001',
      quantity: 1,
      request_date: '2026-06-15',
      status: 'FOLLOW_UP',
      issue_summary: 'Restore warranty replacement row',
      vendor_reference: 'RMA-RESTORE-1',
      follow_up_date: '2026-06-20'
    }, sourceOwner.token);
    assert.match(warranty.replacement.replacement_number, /^WR-/);
    const gstr2bImport = await request(source, 'POST', '/reports/gst/gstr2b/import', {
      org_id: org.id,
      fy: '2026-27',
      file_name: 'restore-gstr2b.json',
      json: {
        invoices: [{
          supplier_gstin: '37ABCDE1234F1Z5',
          supplier_name: 'Recovery Supplier',
          invoice_number: 'SUP-RESTORE-1',
          invoice_date: '2026-06-13',
          taxable_amount: 1000,
          cgst: 90,
          sgst: 90
        }]
      }
    }, sourceOwner.token);
    assert.strictEqual(gstr2bImport.imported, 1);
    const catalog = await request(source, 'GET', `/jobs/catalog?org_id=${org.id}`, undefined, sourceOwner.token);
    const job = await request(source, 'POST', '/jobs', {
      org_id: org.id,
      party_id: party.id,
      priority: 'HIGH',
      promised_delivery_at: '2026-06-20T18:30:00.000Z',
      customer_commitment: 'Restore this job end to end.',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Recovery binding task',
        specifications: { size: 'A4', finish: 'Gloss' },
        quantity: 1,
        unit: 'BOOKS'
      }],
      estimate_lines: [{
        description: 'Recovery binding task',
        quantity: 1,
        unit: 'BOOKS',
        unit_price: 300,
        tax_rate: 0,
        line_total: 300
      }]
    }, sourceOwner.token);
    await request(source, 'POST', `/jobs/${job.id}/internal-notes`, {
      note_type: 'INSTRUCTION',
      note_text: 'Restore test instruction for the production team.',
      file_names: ['restore-instruction.pdf']
    }, sourceOwner.token, 201);
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn9xJgAAAAASUVORK5CYII=';
    await request(source, 'POST', `/jobs/${job.id}/attachments`, {
      file_name: 'restore-reference.png',
      mime_type: 'image/png',
      content_base64: pngBase64,
      visible_to_customer: true
    }, sourceOwner.token);
    const addition = await request(source, 'POST', `/jobs/${job.id}/additions`, {
      reason: 'Add lamination',
      attachments: [{
        file_name: 'lamination-note.png',
        mime_type: 'image/png',
        content_base64: pngBase64
      }]
    }, sourceOwner.token);
    await request(source, 'PUT', `/jobs/additions/${addition.id}/price`, {
      customer_description: 'Add lamination',
      quantity: 1,
      unit: 'NOS',
      unit_price: 75,
      tax_rate: 0
    }, sourceOwner.token);
    const customerAccess = await request(source, 'POST', `/jobs/${job.id}/customer-access`, {
      valid_days: 10
    }, sourceOwner.token);
    await request(source, 'POST', `/job-portal/${customerAccess.token}/uploads`, {
      file_name: 'customer-proof.png',
      mime_type: 'image/png',
      content_base64: pngBase64,
      purpose: 'CUSTOMER_UPLOAD'
    });
    await request(source, 'POST', `/job-portal/${customerAccess.token}/additions/${addition.id}/decision`, {
      decision: 'APPROVED',
      method: 'DIGITAL_SIGNATURE',
      approver_name: 'Recovery Customer',
      signature_data: 'Recovery Customer',
      confirmation_text: 'Approved after backup restore test.'
    });
    await request(source, 'GET',
      `/advanced/sync/snapshot?org_id=${org.id}&device_id=DEV-BACKUP-001`, undefined, sourceOwner.token);

    const encryptedBackup = await request(
      source, 'POST', '/backup/run-automatic', {}, sourceOwner.token
    );
    assert.strictEqual(encryptedBackup.success, true);
    assert.strictEqual(encryptedBackup.verification.status, 'PASSED');
    assert.strictEqual(encryptedBackup.verification.integrity, 'ok');
    assert.ok(encryptedBackup.verification.summary.organizations >= 2);
    assert.ok(fs.existsSync(encryptedBackup.file_name));

    const automaticSettings = await request(
      source, 'GET', '/backup/automatic-settings', undefined, sourceOwner.token
    );
    assert.strictEqual(automaticSettings.latest_verification.status, 'PASSED');
    const successfulVerificationId = automaticSettings.latest_verification.id;
    const verificationHistory = await request(
      source, 'GET', '/backup/verification-history?limit=10', undefined, sourceOwner.token
    );
    assert.ok(verificationHistory.some(row => row.id === successfulVerificationId && row.status === 'PASSED'));

    const restoreDrill = await request(
      source, 'POST', '/backup/restore-drills',
      { backup_log_id: encryptedBackup.backup_log_id, notes: 'Release test isolated restore drill completed successfully.' }, sourceOwner.token
    );
    assert.strictEqual(restoreDrill.status, 'PASSED');
    const settingsAfterDrill = await request(
      source, 'GET', '/backup/automatic-settings', undefined, sourceOwner.token
    );
    assert.strictEqual(settingsAfterDrill.latest_restore_drill.status, 'PASSED');
    assert.strictEqual(settingsAfterDrill.restore_drill_health.due, false);
    const drillHistory = await request(source, 'GET', '/backup/restore-drills?limit=10', undefined, sourceOwner.token);
    assert.ok(drillHistory.some(row => Number(row.id) === Number(restoreDrill.drill_id) && row.status === 'PASSED'));

    fs.writeFileSync(encryptedBackup.file_name, Buffer.from('intentionally-corrupt-test-backup'));
    const failedVerification = await request(
      source, 'POST', '/backup/verify-automatic',
      { backup_log_id: encryptedBackup.backup_log_id }, sourceOwner.token, 400
    );
    assert.strictEqual(failedVerification.status, 'FAILED');
    assert.match(failedVerification.error, /backup|encrypted|payload|short|invalid/i);
    const failedHistory = await request(
      source, 'GET', '/backup/verification-history?limit=1', undefined, sourceOwner.token
    );
    assert.strictEqual(failedHistory[0].status, 'FAILED');
    const verificationTemp = path.join(sourceDir, 'backup-verification-temp');
    assert.deepStrictEqual(fs.existsSync(verificationTemp) ? fs.readdirSync(verificationTemp) : [], []);

    const backup = await request(
      source, 'GET', `/backup/export?org_id=${org.id}&fy=2026-27`,
      undefined, sourceOwner.token
    );
    assert.strictEqual(backup.version, '1.0.0');
    assert.ok(backup.audit_log.length > 0);
    assert.strictEqual(backup.payment_allocations.length, 1);
    assert.strictEqual(backup.party_addresses.length, 1);
    assert.strictEqual(backup.warranty_replacements.length, 1);
    assert.strictEqual(backup.gstr2b_rows.length, 1);
    assert.strictEqual(backup.job_orders.length, 1);
    assert.ok(backup.job_attachments.length >= 3);
    assert.strictEqual(backup.job_additions.length, 1);
    assert.strictEqual(backup.job_internal_notes.length, 1);
    assert.strictEqual(backup.job_customer_access_tokens.length, 1);
    assert.strictEqual(backup.registered_devices.length, 1);
    assert.strictEqual(backup.registered_devices[0].device_id, 'DEV-BACKUP-001');
    assert.strictEqual(backup.sync_cursors.length, 1);

    await stopServer(source);
    source = null;

    target = await startServer(targetDir, 3233);
    const targetOwner = await request(target, 'POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    });
    const restored = await request(target, 'POST', '/backup/import', backup, targetOwner.token);
    assert.strictEqual(restored.success, true);
    assert.strictEqual(restored.imported.orgs, 1);
    assert.strictEqual(restored.imported.items, 1);
    assert.strictEqual(restored.imported.bills, 2);
    assert.strictEqual(restored.imported.payments, 1);
    assert.ok(restored.imported.audit_log > 0);
    assert.strictEqual(restored.imported.party_addresses, 1);
    assert.strictEqual(restored.imported.warranty_replacements, 1);
    assert.strictEqual(restored.imported.gstr2b_rows, 1);
    assert.strictEqual(restored.imported.jobs, 1);
    assert.ok(restored.imported.job_attachments >= 3);
    assert.strictEqual(restored.imported.job_additions, 1);
    assert.strictEqual(restored.imported.job_internal_notes, 1);
    assert.strictEqual(restored.imported.registered_devices, 1);
    assert.strictEqual(restored.imported.sync_cursors, 1);

    const restoredOrg = (await request(target, 'GET', '/orgs', undefined, targetOwner.token))
      .find(row => row.display_name === 'Roundtrip Recovery Company');
    assert.ok(restoredOrg);
    assert.strictEqual(restoredOrg.invoice_theme, 'emerald');
    const restoredDevices = await request(
      target, 'GET', `/advanced/registered-devices?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    );
    assert.strictEqual(restoredDevices.length, 1);
    assert.strictEqual(restoredDevices[0].device_id, 'DEV-BACKUP-001');
    const restoredItems = await request(
      target, 'GET', `/items?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    );
    assert.strictEqual(restoredItems[0].item_code, 'REC-KB-01');
    assert.strictEqual(restoredItems[0].barcode, '890000000001');
    const restoredBills = await request(
      target, 'GET', `/bills?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    );
    assert.strictEqual(restoredBills.length, 2);
    const restoredSaleBill = restoredBills.find(row => row.format === 'SALE');
    assert.ok(restoredSaleBill);
    const fullBill = await request(
      target, 'GET', `/bills/${restoredSaleBill.id}/full`, undefined, targetOwner.token
    );
    assert.strictEqual(fullBill.items[0].item_description, 'Serial REC-001');
    assert.strictEqual(fullBill.delivery.tracking_id, 'REC-LR-1');
    assert.strictEqual(fullBill.payment_status, 'paid');
    const restoredParty = (await request(
      target, 'GET', `/parties?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    )).find(row => row.name === 'Recovery Customer');
    assert.ok(restoredParty);
    const restoredAddresses = await request(
      target, 'GET', `/parties/${restoredParty.id}/addresses?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    );
    assert.ok(restoredAddresses.some(address => address.label === 'Recovery Branch Address'));
    const restoredWarranty = await request(
      target, 'GET', `/warranty-replacements?org_id=${restoredOrg.id}&search=REC-SN-001`,
      undefined, targetOwner.token
    );
    assert.strictEqual(restoredWarranty.length, 1);
    assert.strictEqual(restoredWarranty[0].vendor_reference, 'RMA-RESTORE-1');
    assert.strictEqual(restoredWarranty[0].original_sale_bill_number, restoredSaleBill.bill_number);
    const restoredGstr2b = await request(
      target, 'GET', `/reports/gst/gstr2b?org_id=${restoredOrg.id}&fy=2026-27`,
      undefined, targetOwner.token
    );
    assert.ok(restoredGstr2b.some(row => row.invoice_number === 'SUP-RESTORE-1'));
    const restoredJobs = await request(
      target, 'GET', `/jobs?org_id=${restoredOrg.id}`, undefined, targetOwner.token
    );
    assert.strictEqual(restoredJobs.length, 1);
    const restoredJob = await request(
      target, 'GET', `/jobs/${restoredJobs[0].id}`, undefined, targetOwner.token
    );
    assert.strictEqual(restoredJob.items.length, 1);
    assert.ok(restoredJob.attachments.some(file => file.file_name === 'restore-reference.png'));
    assert.ok(restoredJob.attachments.some(file => file.file_name === 'customer-proof.png'));
    assert.strictEqual(restoredJob.additions[0].state, 'APPROVED');
    assert.strictEqual(restoredJob.internal_notes.length, 1);
    assert.strictEqual(restoredJob.internal_notes[0].file_names[0], 'restore-instruction.pdf');
    const restoredPortal = await request(
      target, 'GET', `/job-portal/${customerAccess.token}`, undefined, undefined
    );
    assert.strictEqual(restoredPortal.job_token, job.token);
    assert.ok(restoredPortal.attachments.some(file => file.file_name === 'customer-proof.png'));
    const restoredAudit = await request(
      target, 'GET', `/jobs/${restoredJobs[0].id}/audit`, undefined, targetOwner.token
    );
    assert.ok(restoredAudit.some(entry => entry.actor_role === 'CUSTOMER'));
    console.log('Backup round-trip integration tests passed');
  } finally {
    await stopServer(source);
    await stopServer(target);
    await cleanupDir(sourceDir);
    await cleanupDir(targetDir);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
