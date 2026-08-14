const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.feature-test');
const port = 3197;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });

async function request(method, route, body, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch (_) { throw new Error(`${method} ${route}: non-JSON response ${response.status} ${text.slice(0, 80)}`); }
  if (!response.ok) throw new Error(`${method} ${route}: ${payload.error || response.status}`);
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 450; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start:\n${serverOutput}`);
}

(async () => {
  try {
    await waitForServer();
    const login = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    let token = login.token;
    const seededOrgs = await request('GET', '/orgs', undefined, token);
    const computerOrg = seededOrgs.find(org => org.display_name === 'BITS & BINARY');
    assert.ok(computerOrg, 'Seeded computer company was not found');
    const computerItems = await request('GET', `/items?org_id=${computerOrg.id}`, undefined, token);
    const preloadedComputerItems = computerItems.filter(item => String(item.item_code || '').startsWith('COM-'));
    assert.strictEqual(preloadedComputerItems.length, 26);
    assert.ok(preloadedComputerItems.every(item => /^\d{8}$/.test(item.hsn_code)));
    assert.strictEqual(preloadedComputerItems.find(item => item.item_code === 'COM-MOU-001').hsn_code, '84716060');
    assert.strictEqual(preloadedComputerItems.find(item => item.item_code === 'COM-KBD-001').hsn_code, '84716040');
    assert.strictEqual(preloadedComputerItems.find(item => item.item_code === 'COM-PRN-001').hsn_code, '84433240');
    assert.strictEqual(preloadedComputerItems.find(item => item.item_code === 'COM-PWB-001').hsn_code, '85076000');
    assert.strictEqual(new Set(preloadedComputerItems.map(item => item.item_code)).size, 26);
    const warrantyParty = await request('POST', '/parties', {
      org_id: computerOrg.id,
      type: 'customer',
      name: 'Warranty Customer',
      phone: '9999999999',
      gst_type: 'unregistered'
    }, token);
    const warrantyItem = preloadedComputerItems.find(item => item.item_code === 'COM-SSD-001') || preloadedComputerItems[0];
    const warrantySale = await request('POST', '/bills', {
      org_id: computerOrg.id,
      format: 'SALE',
      bill_date: '2026-06-09',
      party_id: warrantyParty.id,
      payment_mode: 'credit',
      items: [{
        item_id: warrantyItem.id,
        item_name: warrantyItem.name,
        hsn_code: warrantyItem.hsn_code,
        unit: warrantyItem.unit || 'NOS',
        qty: 1,
        rate: 2500,
        amount: 2500,
        gst_rate: 18
      }]
    }, token);
    const warrantyDelivery = await request('POST', '/bills', {
      org_id: computerOrg.id,
      format: 'DC',
      bill_date: '2026-06-10',
      party_id: warrantyParty.id,
      payment_mode: 'credit',
      items: [{
        item_id: warrantyItem.id,
        item_name: warrantyItem.name,
        hsn_code: warrantyItem.hsn_code,
        unit: warrantyItem.unit || 'NOS',
        qty: 1,
        rate: 0,
        amount: 0,
        gst_rate: 0
      }]
    }, token);
    await assert.rejects(
      () => request('POST', '/warranty-replacements', {
        org_id: computerOrg.id,
        party_id: warrantyParty.id,
        original_sale_bill_id: warrantySale.bill.id,
        delivery_bill_id: warrantyDelivery.bill.id,
        product_item_id: warrantyItem.id,
        quantity: 1,
        request_date: '2026-06-11',
        issue_summary: 'SSD not detected'
      }, token),
      /Serial number is required/
    );
    const warrantyCase = await request('POST', '/warranty-replacements', {
      org_id: computerOrg.id,
      party_id: warrantyParty.id,
      original_sale_bill_id: warrantySale.bill.id,
      delivery_bill_id: warrantyDelivery.bill.id,
      product_item_id: warrantyItem.id,
      serial_number: 'SSD-SN-1001',
      quantity: 1,
      request_date: '2026-06-11',
      status: 'OPEN',
      issue_summary: 'SSD not detected under warranty',
      vendor_reference: 'RMA-1001',
      follow_up_date: '2026-06-14'
    }, token);
    assert.match(warrantyCase.replacement.replacement_number, /^WR-2026-\d{4}$/);
    const warrantyList = await request('GET', `/warranty-replacements?org_id=${computerOrg.id}&search=SSD-SN-1001`, undefined, token);
    assert.strictEqual(warrantyList.length, 1);
    assert.strictEqual(warrantyList[0].delivery_bill_number, warrantyDelivery.bill.bill_number);
    assert.strictEqual(warrantyList[0].original_sale_bill_number, warrantySale.bill.bill_number);
    assert.strictEqual(warrantyList[0].party_name, 'Warranty Customer');
    const commonCustomers = await request('GET', `/warranty-replacements/common-customers?org_id=${computerOrg.id}`, undefined, token);
    assert.strictEqual(commonCustomers.length, 3);
    assert.deepStrictEqual(commonCustomers.map(row => row.slot), [1, 2, 3]);
    const normalPartyRows = await request('GET', `/parties?org_id=${computerOrg.id}`, undefined, token);
    assert.ok(normalPartyRows.every(row => Number(row.is_common_ledger || 0) === 0));
    const commonDelivery = await request('POST', '/bills', {
      org_id: computerOrg.id,
      format: 'DC',
      bill_date: '2026-06-11',
      party_id: commonCustomers[0].id,
      payment_mode: 'credit',
      items: [{ item_id: warrantyItem.id, item_name: warrantyItem.name, hsn_code: warrantyItem.hsn_code,
        unit: warrantyItem.unit || 'NOS', qty: 1, rate: 0, amount: 0, gst_rate: 0 }]
    }, token);
    const commonCase = await request('POST', '/warranty-replacements', {
      org_id: computerOrg.id,
      party_id: commonCustomers[0].id,
      common_customer_slot: 1,
      customer_name: 'Walk-in Warranty Customer',
      customer_phone: '9888877777',
      customer_email: 'walkin@example.test',
      customer_address: 'Kakinada Walk-in Counter',
      delivery_bill_id: commonDelivery.bill.id,
      product_item_id: warrantyItem.id,
      serial_number: 'COMMON-SN-001',
      quantity: 1,
      request_date: '2026-06-11',
      issue_summary: 'Unknown customer warranty reference'
    }, token);
    assert.strictEqual(commonCase.replacement.customer_mode, 'COMMON');
    assert.strictEqual(commonCase.replacement.customer_name, 'Walk-in Warranty Customer');
    assert.strictEqual(commonCase.replacement.customer_phone, '9888877777');
    const commonSearch = await request('GET', `/warranty-replacements?org_id=${computerOrg.id}&search=9888877777`, undefined, token);
    assert.strictEqual(commonSearch[0].party_name, 'Walk-in Warranty Customer');
    const otherWarrantyParty = await request('POST', '/parties', {
      org_id: computerOrg.id, type: 'customer', name: 'Other Warranty Customer', gst_type: 'unregistered'
    }, token);
    const otherSale = await request('POST', '/bills', {
      org_id: computerOrg.id, format: 'SALE', bill_date: '2026-06-09',
      party_id: otherWarrantyParty.id, payment_mode: 'credit',
      items: [{ item_id: warrantyItem.id, item_name: warrantyItem.name, hsn_code: warrantyItem.hsn_code,
        unit: warrantyItem.unit || 'NOS', qty: 1, rate: 100, amount: 100, gst_rate: 18 }]
    }, token);
    await assert.rejects(
      () => request('POST', '/warranty-replacements', {
        org_id: computerOrg.id,
        party_id: warrantyParty.id,
        original_sale_bill_id: otherSale.bill.id,
        delivery_bill_id: warrantyDelivery.bill.id,
        product_item_id: warrantyItem.id,
        serial_number: 'SSD-SN-WRONG-SALE',
        quantity: 1,
        request_date: '2026-06-11',
        issue_summary: 'Wrong customer sale proof'
      }, token),
      /Original sale invoice must belong to the selected party/
    );
    const serviceCenter = await request('POST', '/warranty-replacements/service-centers', {
      org_id: computerOrg.id,
      name: 'SSD Brand Service Center',
      category: 'Storage',
      brand: 'SSD Brand',
      contact_person: 'Service Desk',
      phone: '9000000001',
      address: 'Kakinada Service Lane',
      courier_instructions: 'Send with serial number and DC copy'
    }, token);
    assert.ok(serviceCenter.service_center.id);
    const warrantyFollowup = await request('PUT', `/warranty-replacements/${warrantyCase.replacement.id}`, {
      org_id: computerOrg.id,
      party_id: warrantyParty.id,
      original_sale_bill_id: warrantySale.bill.id,
      delivery_bill_id: warrantyDelivery.bill.id,
      product_item_id: warrantyItem.id,
      serial_number: 'SSD-SN-1001',
      quantity: 1,
      request_date: '2026-06-11',
      status: 'SENT_TO_VENDOR',
      service_center_id: serviceCenter.service_center.id,
      issue_summary: 'SSD not detected under warranty',
      vendor_reference: 'RMA-1001',
      courier_vendor: 'DTDC',
      courier_tracking_number: 'D123456789',
      sent_date: '2026-06-12',
      expected_return_date: '2026-06-20',
      rma_number: 'RMA-1001',
      service_center_contact: 'Service Desk 9000000001',
      service_center_ack_status: 'Accepted',
      follow_up_date: '2026-06-20',
      resolution_notes: 'Vendor asked for purchase proof and photos.'
    }, token);
    assert.strictEqual(warrantyFollowup.replacement.status, 'SENT_TO_VENDOR');
    const sentWarranty = await request('GET', `/warranty-replacements?org_id=${computerOrg.id}&status=SENT_TO_VENDOR`, undefined, token);
    assert.strictEqual(sentWarranty[0].service_center_name, 'SSD Brand Service Center');
    assert.strictEqual(sentWarranty[0].courier_tracking_number, 'D123456789');
    const regularOrg = await request('POST', '/orgs', {
      display_name: 'Feature Regular', registered_name: 'Feature Regular',
      gstin: '37AEPFS0104Q1ZK',
      gst_type: 'regular', note_header: 'Configured header', note_footer: 'Configured footer',
      invoice_description: 'Configured description', project_bw_rate: 2,
      project_colour_rate: 5, project_book_rate: 120, invoice_theme: 'common-gst'
    }, token);
    const compositionOrg = await request('POST', '/orgs', {
      display_name: 'Feature Composition', registered_name: 'Feature Composition',
      gst_type: 'composition', invoice_theme: 'emerald'
    }, token);
    const inclusiveOrg = await request('POST', '/orgs', {
      display_name: 'Inclusive Company', registered_name: 'Inclusive Company',
      gstin: '37AEPFS0104Q1ZK', gst_type: 'regular',
      default_tax_inclusive: true,
      invoice_prefixes: { SALE: 'TAXINC' }, invoice_theme: 'sunset'
    }, token);
    const gstThemeOrg = await request('POST', '/orgs', {
      display_name: 'GST Theme Company', registered_name: 'GST Theme Company',
      gstin: '37AEPFS0104Q1ZK', gst_type: 'regular', invoice_theme: 'gst-invoice'
    }, token);
    const referenceThemeOrg = await request('POST', '/orgs', {
      display_name: 'Reference Theme Company', registered_name: 'Reference Theme Company',
      gstin: '37AEPFS0104Q1ZK', gst_type: 'regular', invoice_theme: 'statutory-gst'
    }, token);
    const controlsOrg = await request('POST', '/orgs', {
      display_name: 'Controls Company', registered_name: 'Controls Company',
      gst_type: 'regular'
    }, token);
    const closeStatus = await request('GET', `/business/locks/2026-27/status?org_id=${controlsOrg.id}`, undefined, token);
    assert.strictEqual(closeStatus.can_close, true);
    assert.strictEqual(closeStatus.report.trial_balance.difference, 0);
    const closedYear = await request('POST', '/business/locks/2026-27/close', {
      org_id: controlsOrg.id,
      note: 'Owner verified empty year before closing'
    }, token);
    assert.strictEqual(closedYear.status.lock.closed, 1);
    assert.strictEqual(closedYear.status.lock.locked, 1);
    await assert.rejects(
      () => request('POST', '/bills', {
        org_id: controlsOrg.id, format: 'SALE', bill_date: '2026-06-10',
        payment_mode: 'cash',
        items: [{ item_name: 'Locked Year Test', qty: 1, rate: 10, amount: 10, unit: 'NOS', gst_rate: 18 }]
      }, token),
      /Financial year 2026-27 is locked/
    );
    const reopenedYear = await request('POST', '/business/locks/2026-27/reopen', {
      org_id: controlsOrg.id,
      reason: 'Correction required before final audit'
    }, token);
    assert.strictEqual(reopenedYear.status.lock.closed, 0);
    assert.strictEqual(reopenedYear.status.lock.locked, 0);
    const gstLookup = await request('GET', '/parties/gst-fetch/37AEPFS0104Q1ZK', undefined, token);
    assert.strictEqual(gstLookup.success, true);
    assert.strictEqual(gstLookup.state, 'Andhra Pradesh');
    assert.strictEqual(gstLookup.gst_type, 'regular');
    assert.strictEqual((await request('GET', `/orgs/${regularOrg.id}`, undefined, token)).invoice_theme, 'common-gst');
    assert.strictEqual((await request('GET', `/orgs/${compositionOrg.id}`, undefined, token)).invoice_theme, 'emerald');
    assert.strictEqual((await request('GET', `/orgs/${inclusiveOrg.id}`, undefined, token)).invoice_theme, 'sunset');
    assert.strictEqual((await request('GET', `/orgs/${gstThemeOrg.id}`, undefined, token)).invoice_theme, 'gst-invoice');
    assert.strictEqual((await request('GET', `/orgs/${referenceThemeOrg.id}`, undefined, token)).invoice_theme, 'statutory-gst');

    const sharedParty = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'both', name: 'Shared Multi Company Party',
      registered_name: 'Shared Multi Company Party', gst_type: 'unregistered',
      opening_balance: 250, balance_type: 'dr', shared: true
    }, token);
    const compositionParties = await request('GET', `/parties?org_id=${compositionOrg.id}`, undefined, token);
    assert.ok(compositionParties.some(party => Number(party.id) === Number(sharedParty.id)));
    const compositionItem = await request('POST', '/items', {
      org_id: compositionOrg.id, name: 'Composition Company Master Item', item_code: 'COM-MASTER-1',
      hsn_code: '84713010', unit: 'NOS', gst_rate: 18, last_sale_price: 125
    }, token);
    const normalizedMasterItemBill = await request('POST', '/bills', {
      org_id: compositionOrg.id, format: 'SALE', bill_date: '2026-06-05',
      party_id: sharedParty.id, payment_mode: 'credit',
      items: [{ item_id: compositionItem.id, item_name: '', qty: 1, rate: 125, amount: 125, unit: '', gst_rate: '' }]
    }, token);
    assert.strictEqual(normalizedMasterItemBill.bill.items[0].item_name, 'Composition Company Master Item');
    await assert.rejects(
      () => request('POST', '/bills', {
        org_id: regularOrg.id, format: 'SALE', bill_date: '2026-06-05',
        party_id: sharedParty.id, payment_mode: 'credit',
        items: [{ item_id: compositionItem.id, item_name: '', qty: 1, rate: 125, amount: 125, unit: '', gst_rate: '' }]
      }, token),
      /does not belong to this company/
    );
    const sharedBill = await request('POST', '/bills', {
      org_id: compositionOrg.id, format: 'SALE', bill_date: '2026-06-05',
      party_id: sharedParty.id, payment_mode: 'credit',
      items: [{ item_name: 'Shared Party Service', qty: 1, rate: 100, amount: 100, unit: 'NOS', gst_rate: 0 }]
    }, token);
    assert.strictEqual(Number(sharedBill.bill.party_id), Number(sharedParty.id));
    const compositionItems = await request('GET', `/items?org_id=${compositionOrg.id}`, undefined, token);
    const autoCreatedItems = compositionItems.filter(item => item.name === 'Shared Party Service');
    assert.strictEqual(autoCreatedItems.length, 1);
    assert.strictEqual(Number(sharedBill.bill.items[0].item_id), Number(autoCreatedItems[0].id));
    const computerParties = await request('GET', `/parties?org_id=${computerOrg.id}`, undefined, token);
    assert.ok(computerParties.some(party => Number(party.id) === Number(sharedParty.id)));
    const sharedQuotation = await request('POST', '/bills', {
      org_id: regularOrg.id, format: 'QUOT', bill_date: '2026-06-05',
      party_id: sharedParty.id, payment_mode: 'credit',
      items: [{ item_name: 'Shared Quotation Service', qty: 1, rate: 300, amount: 300, unit: 'NOS', gst_rate: 0 }]
    }, token);
    await assert.rejects(
      () => request('POST', '/advanced/duplicate', {
        type: 'bill', id: sharedQuotation.id, org_id: computerOrg.id, date: '2026-06-06'
      }, token),
      /original company/
    );

    const firstSharedVendor = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'vendor', name: 'Bits Quotation Vendor One',
      address: 'Vendor One Road', city: 'Kakinada', shared: true, gst_type: 'unregistered'
    }, token);
    const secondSharedVendor = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'vendor', name: 'Bits Quotation Vendor Two',
      address: 'Vendor Two Road', city: 'Samalkot', shared: true, gst_type: 'unregistered'
    }, token);
    const vendorQuote = await request('POST', '/bills', {
      org_id: computerOrg.id, format: 'QUOT', bill_date: '2026-06-06',
      party_id: firstSharedVendor.id, party_name_confirmation: 'Bits Quotation Vendor One',
      payment_mode: 'credit',
      items: [{ item_name: 'Vendor Quotation Item', qty: 1, rate: 250, amount: 250, unit: 'NOS', gst_rate: 18 }]
    }, token);
    const vendorQuoteFull = await request('GET', `/bills/${vendorQuote.id}/full`, undefined, token);
    await assert.rejects(
      () => request('PUT', `/bills/${vendorQuote.id}`, {
        party_id: secondSharedVendor.id,
        party_name_confirmation: 'Bits Quotation Vendor One',
        bill_date: vendorQuoteFull.bill_date,
        payment_mode: vendorQuoteFull.payment_mode,
        items: vendorQuoteFull.items
      }, token),
      /Selected customer\/vendor name does not match/
    );
    const changedVendorQuote = await request('PUT', `/bills/${vendorQuote.id}`, {
      party_id: secondSharedVendor.id,
      party_name_confirmation: 'Bits Quotation Vendor Two',
      billing_address_id: null,
      delivery_address_id: null,
      delivery_address: 'Vendor Two Road, Samalkot, Andhra Pradesh',
      bill_date: vendorQuoteFull.bill_date,
      payment_mode: vendorQuoteFull.payment_mode,
      items: vendorQuoteFull.items
    }, token);
    assert.strictEqual(Number(changedVendorQuote.bill.party_id), Number(secondSharedVendor.id));
    assert.strictEqual(changedVendorQuote.bill.party.name, 'Bits Quotation Vendor Two');
    assert.match(changedVendorQuote.bill.party_snapshot, /Bits Quotation Vendor Two/);
    const bitsQuotationRegister = await request(
      'GET', `/bills?org_id=${computerOrg.id}&format=QUOT&search=${encodeURIComponent(vendorQuote.bill.bill_number)}`, undefined, token
    );
    assert.strictEqual(bitsQuotationRegister.find(row => Number(row.id) === Number(vendorQuote.id)).party_name, 'Bits Quotation Vendor Two');

    const governmentParty = await request('POST', '/parties', {
      org_id: regularOrg.id,
      type: 'customer',
      name: 'Mandal Revenue Office',
      registered_name: 'Mandal Revenue Office',
      phone: '8888800000',
      address: 'Main MRO Office',
      city: 'Kakinada',
      state: 'Andhra Pradesh',
      pincode: '533001',
      gst_type: 'unregistered'
    }, token);
    const defaultGovernmentAddresses = await request('GET', `/parties/${governmentParty.id}/addresses?org_id=${regularOrg.id}`, undefined, token);
    assert.strictEqual(defaultGovernmentAddresses.length, 1);
    const villageAddress = await request('POST', `/parties/${governmentParty.id}/addresses`, {
      label: 'Samalkot Village Office',
      address_type: 'billing_delivery',
      contact_person: 'Village Secretary',
      phone: '8888811111',
      address: 'Revenue Office, Main Road',
      city: 'Samalkot',
      district: 'Kakinada',
      state: 'Andhra Pradesh',
      pincode: '533440',
      is_default_billing: true,
      is_default_delivery: true
    }, token);
    const governmentQuote = await request('POST', '/bills', {
      org_id: regularOrg.id,
      format: 'QUOT',
      bill_date: '2026-06-05',
      party_id: governmentParty.id,
      billing_address_id: villageAddress.id,
      delivery_address_id: villageAddress.id,
      payment_mode: 'credit',
      items: [{ item_name: 'Computer Service Estimate', qty: 1, rate: 500, amount: 500, unit: 'NOS', gst_rate: 18 }]
    }, token);
    assert.match(governmentQuote.bill.billing_address_snapshot, /Samalkot Village Office/);
    assert.match(governmentQuote.bill.delivery_address_snapshot, /533440/);
    assert.match(governmentQuote.bill.delivery_address, /Samalkot/);
    const otherParty = await request('POST', '/parties', {
      org_id: regularOrg.id,
      type: 'customer',
      name: 'Mandal Revenue Office',
      address: 'Other party address',
      city: 'Pithapuram',
      state: 'Andhra Pradesh',
      pincode: '533450',
      gst_type: 'unregistered'
    }, token);
    const otherAddresses = await request('GET', `/parties/${otherParty.id}/addresses?org_id=${regularOrg.id}`, undefined, token);
    await assert.rejects(
      () => request('POST', '/bills', {
        org_id: regularOrg.id,
        format: 'QUOT',
        bill_date: '2026-06-05',
        party_id: governmentParty.id,
        billing_address_id: otherAddresses[0].id,
        payment_mode: 'credit',
        items: [{ item_name: 'Invalid Address Link', qty: 1, rate: 100, amount: 100, unit: 'NOS', gst_rate: 18 }]
      }, token),
      /Selected address does not belong to this party/
    );
    const duplicatedGovernmentQuote = await request('POST', '/advanced/duplicate', {
      type: 'bill', id: governmentQuote.id, org_id: regularOrg.id, date: '2026-06-06'
    }, token);
    const duplicatedGovernmentQuoteFull = await request(
      'GET', `/bills/${duplicatedGovernmentQuote.id}/full`, undefined, token
    );
    const changedDuplicate = await request('PUT', `/bills/${duplicatedGovernmentQuote.id}`, {
      party_id: otherParty.id,
      billing_address_id: null,
      delivery_address_id: null,
      delivery_address: 'Other party address, Pithapuram, Andhra Pradesh, 533450',
      bill_date: duplicatedGovernmentQuoteFull.bill_date,
      payment_mode: duplicatedGovernmentQuoteFull.payment_mode,
      tax_inclusive: Boolean(Number(duplicatedGovernmentQuoteFull.tax_inclusive || 0)),
      items: duplicatedGovernmentQuoteFull.items
    }, token);
    assert.strictEqual(Number(changedDuplicate.bill.party_id), Number(otherParty.id));
    assert.strictEqual(changedDuplicate.bill.party.name, 'Mandal Revenue Office');
    assert.match(changedDuplicate.bill.party_snapshot, /Other party address/);
    assert.match(changedDuplicate.bill.billing_address_snapshot, /Pithapuram/);
    assert.match(changedDuplicate.bill.delivery_address_snapshot, /533450/);
    assert.strictEqual(changedDuplicate.bill.billing_address_id, null);
    assert.strictEqual(changedDuplicate.bill.delivery_address_id, null);
    assert.match(changedDuplicate.bill.delivery_address, /Other party address/);

    const sharedReceipt = await request('POST', '/payments', {
      org_id: compositionOrg.id, payment_date: '2026-06-05',
      party_id: sharedParty.id, type: 'received', mode: 'cash', amount: 40
    }, token);
    assert.ok(sharedReceipt.id);
    const sharedPurchase = await request('POST', '/business/purchases', {
      org_id: compositionOrg.id, purchase_date: '2026-06-05',
      party_id: sharedParty.id, supplier_invoice: 'SHARED-1', payment_mode: 'credit',
      items: [{ item_name: 'Shared Material', qty: 1, entered_rate: 50, rate: 50, gst_rate: 0 }]
    }, token);
    assert.strictEqual(Number(sharedPurchase.purchase.party_id), Number(sharedParty.id));
    const sharedStatement = await request(
      'GET',
      `/reports/party-statement?party_id=${sharedParty.id}&org_id=${compositionOrg.id}&fy=2026-27`,
      undefined,
      token
    );
    assert.ok(sharedStatement.entries.some(entry => entry.entry_type === 'bill'));
    assert.ok(sharedStatement.entries.some(entry => entry.entry_type === 'payment'));
    assert.strictEqual(sharedStatement.entries[0].balance < 250, true);

    const homeOnlyParty = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'customer', name: 'Home Company Only',
      registered_name: 'Home Company Only', gst_type: 'unregistered', shared: false
    }, token);
    await assert.rejects(
      () => request('POST', '/bills', {
        org_id: compositionOrg.id, format: 'SALE', bill_date: '2026-06-05',
        party_id: homeOnlyParty.id, payment_mode: 'cash',
        items: [{ item_name: 'Invalid Company Service', qty: 1, rate: 10, amount: 10, unit: 'NOS', gst_rate: 0 }]
      }, token),
      /does not belong to this company/
    );

    const controlsPayload = await request('GET', `/orgs/${controlsOrg.id}/transaction-controls`, undefined, token);
    assert.ok(controlsPayload.meta.find(row => row.type === 'SALE'));
    assert.strictEqual(controlsPayload.meta.find(row => row.type === 'SALE').defaults.required_fields.qty_unit, true);
    assert.strictEqual(controlsPayload.meta.find(row => row.type === 'PR').defaults.required_fields.amount, true);
    assert.ok(controlsPayload.controls.find(row => row.transaction_type === 'PR'));
    for (const org of seededOrgs) {
      const companyControls = await request('GET', `/orgs/${org.id}/transaction-controls`, undefined, token);
      const quotationMeta = companyControls.meta.find(row => row.type === 'QUOT');
      const quotation = companyControls.controls.find(row => row.transaction_type === 'QUOT');
      assert.ok(quotationMeta?.fields.some(([field]) => field === 'payment_status'));
      assert.strictEqual(quotationMeta.defaults.print_options.payment_status, false);
      assert.strictEqual(quotationMeta.defaults.print_options.operator, false);
      assert.strictEqual(quotationMeta.defaults.print_options.digital_signature, false);
      assert.strictEqual(quotation.print_options.payment_status, false);
      assert.strictEqual(quotation.print_options.operator, false);
      assert.strictEqual(quotation.print_options.digital_signature, false);
    }
    const controlsRows = controlsPayload.controls.map(row => ({
      transaction_type: row.transaction_type,
      form_options: row.form_options,
      required_fields: row.required_fields,
      print_options: row.print_options
    }));
    const saleControl = controlsRows.find(row => row.transaction_type === 'SALE');
    saleControl.required_fields.party = true;
    saleControl.print_options.hsn = false;
    const receiptControl = controlsRows.find(row => row.transaction_type === 'PR');
    receiptControl.required_fields.reference = true;
    await request('PUT', `/orgs/${controlsOrg.id}/transaction-controls`, { controls: controlsRows }, token);
    const invalidBillResponse = await fetch(`http://127.0.0.1:${port}/api/bills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        org_id: controlsOrg.id, format: 'SALE', bill_date: '2026-06-06',
        payment_mode: 'cash',
        items: [{ item_name: 'Control Item', hsn_code: '998734', qty: 1, rate: 100, amount: 100, unit: 'NOS', gst_rate: 18 }]
      })
    });
    assert.strictEqual(invalidBillResponse.status, 400);
    assert.match((await invalidBillResponse.json()).error, /Party/);
    await assert.rejects(
      () => request('POST', '/payments', {
        org_id: controlsOrg.id, payment_date: '2026-06-06',
        type: 'received', mode: 'cash', amount: 10
      }, token),
      /Reference/
    );
    saleControl.form_options.party = false;
    saleControl.required_fields.party = true;
    receiptControl.form_options.reference = false;
    receiptControl.form_options.bank_reference = false;
    receiptControl.required_fields.reference = true;
    await request('PUT', `/orgs/${controlsOrg.id}/transaction-controls`, { controls: controlsRows }, token);
    const hiddenPartyBill = await request('POST', '/bills', {
      org_id: controlsOrg.id, format: 'SALE', bill_date: '2026-06-06',
      payment_mode: 'cash',
      items: [{ item_name: 'Control Item', hsn_code: '998734', qty: 1, rate: 100, amount: 100, unit: 'NOS', gst_rate: 18 }]
    }, token);
    assert.strictEqual(hiddenPartyBill.bill.party_id, null);
    const hiddenReferencePayment = await request('POST', '/payments', {
      org_id: controlsOrg.id, payment_date: '2026-06-06',
      type: 'received', mode: 'upi', amount: 10
    }, token);
    assert.ok(hiddenReferencePayment.id);
    const savedControls = await request('GET', `/orgs/${controlsOrg.id}/transaction-controls`, undefined, token);
    assert.strictEqual(savedControls.controls.find(row => row.transaction_type === 'SALE').required_fields.party, false);
    assert.strictEqual(savedControls.controls.find(row => row.transaction_type === 'PR').required_fields.reference, false);
    const untouchedCompositionControls = await request('GET', `/orgs/${compositionOrg.id}/transaction-controls`, undefined, token);
    assert.strictEqual(untouchedCompositionControls.controls.find(row => row.transaction_type === 'SALE').form_options.party, true);
    const journalControl = controlsRows.find(row => row.transaction_type === 'JOURNAL');
    journalControl.required_fields.footer = true;
    journalControl.form_options.footer = true;
    await request('PUT', `/orgs/${controlsOrg.id}/transaction-controls`, { controls: controlsRows }, token);
    const journalAccounts = await request('GET', `/accounting/accounts?org_id=${controlsOrg.id}`, undefined, token);
    await assert.rejects(
      () => request('POST', '/accounting/journals', {
        org_id: controlsOrg.id, entry_date: '2026-06-06', voucher_type: 'JOURNAL',
        lines: [
          { account_id: journalAccounts[0].id, debit: 10, credit: 0 },
          { account_id: journalAccounts[1].id, debit: 0, credit: 10 }
        ]
      }, token),
      /Narration/
    );
    journalControl.form_options.footer = false;
    journalControl.required_fields.footer = true;
    await request('PUT', `/orgs/${controlsOrg.id}/transaction-controls`, { controls: controlsRows }, token);
    const journalWithoutNarration = await request('POST', '/accounting/journals', {
      org_id: controlsOrg.id, entry_date: '2026-06-06', voucher_type: 'JOURNAL',
      lines: [
        { account_id: journalAccounts[0].id, debit: 10, credit: 0 },
        { account_id: journalAccounts[1].id, debit: 0, credit: 10 }
      ]
    }, token);
    assert.ok(journalWithoutNarration.id);
    await request('PUT', `/orgs/${regularOrg.id}`, {
      ...(await request('GET', `/orgs/${regularOrg.id}`, undefined, token)),
      invoice_print_options: {
        hsn: false,
        rate: false,
        tax_inclusive_value: false,
        bank_details: false
      }
    }, token);
    const printOptionsOrg = await request('GET', `/orgs/${regularOrg.id}`, undefined, token);
    assert.deepStrictEqual(JSON.parse(printOptionsOrg.invoice_print_options), {
      hsn: false,
      rate: false,
      tax_inclusive_value: false,
      bank_details: false
    });
    const customer = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'customer', name: 'Integration Customer',
      registered_name: 'Integration Customer', gst_type: 'unregistered',
      digital_signature_required: true
    }, token);
    const customerRecord = await request('GET', `/parties/${customer.id}`, undefined, token);
    assert.strictEqual(customerRecord.digital_signature_required, 1);
    const lowStockItem = await request('POST', '/items', {
      org_id: regularOrg.id, name: 'Dashboard Low Stock Item', unit: 'NOS',
      hsn_code: '84716040', opening_stock: 0, reorder_level: 2, last_sale_price: 10
    }, token);
    await assert.rejects(
      () => request('POST', '/items', {
        org_id: regularOrg.id, name: 'Missing HSN Validation Item', unit: 'NOS', gst_rate: 18
      }, token),
      /HSN\/SAC code is required/
    );
    const hsnCorrectionItem = await request('POST', '/items', {
      org_id: regularOrg.id, name: 'HSN Correction Item', hsn_code: '4802', unit: 'NOS', gst_rate: 18
    }, token);
    const hsnCorrection = await request('PATCH', `/items/${hsnCorrectionItem.id}/hsn`, {
      hsn_code: '48025690'
    }, token);
    assert.strictEqual(hsnCorrection.hsn_code, '48025690');

    const projectInvoice = await request('POST', '/bills', {
      org_id: regularOrg.id, format: 'PP', bill_date: '2026-06-06', party_id: customer.id,
      description: 'Project description', swipe_charge: 0,
      items: [{ item_name: 'Thesis.pdf', hsn_code: '998734', qty: 1, rate: 1200, amount: 1200, unit: 'NA', gst_rate: 18 }],
      custom_data: {
        project_printing: true,
        rates: { bw: 2, colour: 5, book: 120 },
        rows: [{ file_name: 'Thesis.pdf', bw_prints: 40, colour_prints: 40, books: 3 }],
        optional: []
      }
    }, token);
    assert.strictEqual(projectInvoice.bill.format, 'PP');
    assert.strictEqual(projectInvoice.bill.digital_signature_required, 1);
    assert.strictEqual(projectInvoice.bill.digital_signature_status, 'pending');
    assert.match(projectInvoice.bill.digital_signature_note, /USB DSC token/);
    const signedProjectInvoice = await request('POST', `/bills/${projectInvoice.id}/digital-signature/mark-signed`, {
      confirmation: 'Signed with USB DSC token PIN after PDF review',
      signing_mode: 'hyperpki_provider_detected',
      note: 'Digitally signed using USB DSC token'
    }, token);
    assert.strictEqual(signedProjectInvoice.bill.digital_signature_status, 'signed_in_app');
    assert.ok(signedProjectInvoice.bill.digital_signature_signed_at);
    assert.strictEqual(signedProjectInvoice.bill.digital_signature_signed_by, 1);
    assert.strictEqual(projectInvoice.bill.swipe_charge, 0);
    assert.strictEqual(projectInvoice.bill.description, 'Project description');
    assert.strictEqual(projectInvoice.bill.grand_total, 1416);
    const dashboard = await request('GET', `/reports/dashboard?org_id=${regularOrg.id}&fy=2026-27`, undefined, token);
    assert.strictEqual(dashboard.total_bills, 1);
    assert.strictEqual(dashboard.total_sales, 1416);
    assert.strictEqual(dashboard.low_stock_count, 1);
    assert.ok(dashboard.low_stock.some(item => Number(item.id) === Number(lowStockItem.id)));
    const gstReport = await request('GET', `/reports/gst?org_id=${regularOrg.id}&fy=2026-27`, undefined, token);
    assert.strictEqual(gstReport.gstr1.length, 1);
    const gstr1 = await request('GET', `/reports/gst/export?org_id=${regularOrg.id}&fy=2026-27&period=2026-06&type=gstr1`, undefined, token);
    assert.strictEqual(gstr1.gstin, '37AEPFS0104Q1ZK');
    assert.strictEqual(gstr1.fp, '062026');
    assert.strictEqual(gstr1.b2cs[0].txval, 1200);
    assert.strictEqual(gstr1.hsn.hsn_b2c[0].hsn_sc, '998734');
    assert.strictEqual(gstr1.doc_issue.doc_det[0].docs[0].net_issue, 1);

    const registeredCustomer = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'customer', name: 'Registered Customer',
      registered_name: 'Registered Customer', gstin: '37HVUPD7935P1ZC',
      gst_type: 'regular', state: 'Andhra Pradesh'
    }, token);
    const supplier = await request('POST', '/parties', {
      org_id: regularOrg.id, type: 'supplier', name: 'Registered Vendor',
      registered_name: 'Registered Vendor Private Limited', gstin: '37ABCDE1234F1Z5',
      gst_type: 'regular', state: 'Andhra Pradesh', address: 'Vendor Street'
    }, token);
    await request('POST', '/bills', {
      org_id: regularOrg.id, format: 'SALE', bill_date: '2026-06-07',
      party_id: registeredCustomer.id, payment_mode: 'credit',
      digital_signature_required: false,
      items: [{ item_name: 'Printer', hsn_code: '84433240', qty: 1, rate: 2500, amount: 2500, unit: 'NOS', gst_rate: 18 }]
    }, token);
    const regularBills = await request('GET', `/bills?org_id=${regularOrg.id}&fy=2026-27`, undefined, token);
    const registeredBill = regularBills.find(bill => bill.party_id === registeredCustomer.id);
    assert.ok(registeredBill);
    const dashboardWithCredit = await request('GET', `/reports/dashboard?org_id=${regularOrg.id}&fy=2026-27`, undefined, token);
    assert.strictEqual(Number(dashboardWithCredit.receivable), 2950);
    assert.ok(Number(dashboardWithCredit.overdue_count) >= 0);
    const regularAccounts = await request('GET', `/accounting/accounts?org_id=${regularOrg.id}`, undefined, token);
    const regularCash = regularAccounts.find(account => account.system_key === 'cash');
    const regularPayable = regularAccounts.find(account => account.system_key === 'accounts_payable');
    assert.ok(regularCash && regularPayable);
    const temporarySupplierJournal = await request('POST', '/accounting/journals', {
      org_id: regularOrg.id, entry_date: '2026-06-07', voucher_type: 'JOURNAL',
      narration: 'Temporary supplier balance deletion test',
      lines: [
        { account_id: regularCash.id, debit: 50, credit: 0, narration: 'Temporary cash' },
        { account_id: regularPayable.id, party_id: supplier.id, debit: 0, credit: 50, narration: 'Temporary payable' }
      ]
    }, token);
    const supplierBalanceWithJournal = await request('GET', `/advanced/supplier-balances?org_id=${regularOrg.id}`, undefined, token);
    assert.strictEqual(Number(supplierBalanceWithJournal.find(row => Number(row.id) === Number(supplier.id))?.outstanding), 50);
    await request('DELETE', `/accounting/journals/${temporarySupplierJournal.id}`, {
      reason: 'Remove temporary supplier balance test journal'
    }, token);
    const supplierBalanceAfterDelete = await request('GET', `/advanced/supplier-balances?org_id=${regularOrg.id}`, undefined, token);
    assert.ok(!supplierBalanceAfterDelete.some(row => Number(row.id) === Number(supplier.id)));
    assert.strictEqual(registeredBill.digital_signature_required, 0);
    const portalGstr1 = await request('GET', `/reports/gst/export?org_id=${regularOrg.id}&fy=2026-27&period=2026-06&type=gstr1`, undefined, token);
    assert.strictEqual(portalGstr1.b2b.length, 1);
    assert.strictEqual(portalGstr1.b2b[0].ctin, '37HVUPD7935P1ZC');
    assert.strictEqual(portalGstr1.b2b[0].inv[0].itms[0].itm_det.txval, 2500);
    assert.strictEqual(portalGstr1.hsn.hsn_b2b[0].hsn_sc, '84433240');
    assert.strictEqual(portalGstr1.doc_issue.doc_det[0].docs[0].net_issue, 2);
    const tallyResponse = await fetch(
      `http://127.0.0.1:${port}/api/reports/tally/regular-parties.xml?org_id=${regularOrg.id}&tally_company=${encodeURIComponent('Feature Books 2026')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.strictEqual(tallyResponse.status, 200);
    assert.match(tallyResponse.headers.get('content-type') || '', /xml/);
    const tallyXml = await tallyResponse.text();
    assert.match(tallyXml, /<SVCURRENTCOMPANY>Feature Books 2026<\/SVCURRENTCOMPANY>/);
    assert.match(tallyXml, /<LEDGER NAME="Registered Customer" ACTION="Create">/);
    assert.match(tallyXml, /<PARENT>Sundry Debtors<\/PARENT>/);
    assert.match(tallyXml, /<LEDGER NAME="Registered Vendor" ACTION="Create">/);
    assert.match(tallyXml, /<PARENT>Sundry Creditors<\/PARENT>/);
    assert.match(tallyXml, /<PARTYGSTIN>37ABCDE1234F1Z5<\/PARTYGSTIN>/);
    assert.doesNotMatch(tallyXml, /Integration Customer/);
    const gstr3b = await request('GET', `/reports/gst/export?org_id=${regularOrg.id}&fy=2026-27&type=gstr3b`, undefined, token);
    assert.strictEqual(gstr3b.format, 'TARANGINI_GSTR3B_JSON_V1');
    assert.strictEqual(gstr3b.outward_supplies.total_tax, 666);

    const gstr2bImport = await request('POST', '/reports/gst/gstr2b/import', {
      org_id: regularOrg.id, fy: '2026-27', file_name: 'gstr2b.json',
      json: { invoices: [{ ctin: '37ABCDE1234F1Z5', inum: 'SUP-1', idt: '2026-06-06',
        txval: 1000, iamt: 0, camt: 90, samt: 90 }] }
    }, token);
    assert.strictEqual(gstr2bImport.imported, 1);
    const gstr2b = await request('GET', `/reports/gst/gstr2b?org_id=${regularOrg.id}&fy=2026-27`, undefined, token);
    assert.strictEqual(gstr2b.length, 1);
    assert.strictEqual(gstr2b[0].match_status, 'missing in books');

    const refreshed = await request('POST', '/auth/refresh', { token });
    assert.ok(refreshed.token);
    assert.notStrictEqual(refreshed.token, token);
    assert.strictEqual((await request('GET', '/auth/me', undefined, refreshed.token)).username, 'owner1');
    token = refreshed.token;

    const compositionCustomer = await request('POST', '/parties', {
      org_id: compositionOrg.id, type: 'customer', name: 'Composition Customer',
      registered_name: 'Composition Customer', gst_type: 'unregistered'
    }, token);
    const billOfSupply = await request('POST', '/bills', {
      org_id: compositionOrg.id, format: 'SALE', bill_date: '2026-06-06',
      party_id: compositionCustomer.id, swipe_charge: 3,
      items: [{ item_name: 'Service', qty: 1, rate: 100, amount: 100, unit: 'NOS', gst_rate: 18 }]
    }, token);
    assert.strictEqual(billOfSupply.bill.total_tax, 0);
    assert.strictEqual(billOfSupply.bill.grand_total, 103);

    const inclusiveCustomer = await request('POST', '/parties', {
      org_id: inclusiveOrg.id, type: 'customer', name: 'Inclusive Customer',
      registered_name: 'Inclusive Customer', gst_type: 'unregistered'
    }, token);
    const inclusiveBill = await request('POST', '/bills', {
      org_id: inclusiveOrg.id, format: 'SALE', bill_date: '2026-06-08',
      party_id: inclusiveCustomer.id, payment_mode: 'cash', tax_inclusive: true,
      items: [{ item_name: 'Inclusive Item', hsn_code: '4901', qty: 1, rate: 118,
        amount: 118, unit: 'NOS', gst_rate: 18 }]
    }, token);
    assert.strictEqual(inclusiveBill.bill.tax_inclusive, 1);
    assert.strictEqual(inclusiveBill.bill.taxable_amount, 100);
    assert.strictEqual(inclusiveBill.bill.total_tax, 18);
    assert.strictEqual(inclusiveBill.bill.grand_total, 118);
    assert.match(inclusiveBill.bill.bill_number, /^TAXINC\/26\/\d{4}$/);
    assert.ok(inclusiveBill.bill.bill_number.length <= 16);
    assert.notStrictEqual(inclusiveBill.bill.bill_number.split('/')[0], projectInvoice.bill.bill_number.split('/')[0]);
    const inclusiveAccounts = await request('GET', `/accounting/accounts?org_id=${inclusiveOrg.id}`, undefined, token);
    const inclusiveCash = inclusiveAccounts.find(account => account.system_key === 'cash');
    const inclusiveReceivable = inclusiveAccounts.find(account => account.system_key === 'accounts_receivable');
    assert.ok(inclusiveCash && inclusiveReceivable);
    const cashBalance = dashboard => Number(dashboard.cash_bank.find(row => row.system_key === 'cash')?.balance || 0);
    const cashBeforeManualJournal = cashBalance(await request(
      'GET', `/reports/dashboard?org_id=${inclusiveOrg.id}&fy=2026-27`, undefined, token
    ));
    const manualCashJournal = await request('POST', '/accounting/journals', {
      org_id: inclusiveOrg.id, entry_date: '2026-06-08', voucher_type: 'JOURNAL',
      narration: 'Temporary cash journal for deletion test',
      lines: [
        { account_id: inclusiveCash.id, debit: 50, credit: 0, narration: 'Temporary cash' },
        { account_id: inclusiveReceivable.id, debit: 0, credit: 50, narration: 'Temporary receivable' }
      ]
    }, token);
    const cashWithManualJournal = cashBalance(await request(
      'GET', `/reports/dashboard?org_id=${inclusiveOrg.id}&fy=2026-27`, undefined, token
    ));
    assert.strictEqual(cashWithManualJournal, cashBeforeManualJournal + 50);
    await request('DELETE', `/accounting/journals/${manualCashJournal.id}`, {
      reason: 'Remove temporary cash dashboard test journal'
    }, token);
    const cashAfterManualDelete = cashBalance(await request(
      'GET', `/reports/dashboard?org_id=${inclusiveOrg.id}&fy=2026-27`, undefined, token
    ));
    assert.strictEqual(cashAfterManualDelete, cashBeforeManualJournal);
    const deleteWithoutReason = await fetch(`http://127.0.0.1:${port}/api/bills/${inclusiveBill.bill.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.strictEqual(deleteWithoutReason.status, 400);
    const deleteWithReason = await fetch(`http://127.0.0.1:${port}/api/bills/${inclusiveBill.bill.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: 'Duplicate entry created during review' })
    });
    assert.strictEqual(deleteWithReason.status, 200);
    const afterDeleteBills = await request('GET', `/bills?org_id=${inclusiveOrg.id}&fy=2026-27`, undefined, token);
    assert.ok(!afterDeleteBills.some(row => Number(row.id) === Number(inclusiveBill.bill.id)));
    const afterDeleteBill = await request('POST', '/bills', {
      org_id: inclusiveOrg.id, format: 'SALE', bill_date: '2026-06-08',
      party_id: inclusiveCustomer.id, payment_mode: 'cash',
      items: [{ item_name: 'Next Number Item', hsn_code: '4901', qty: 1, rate: 10,
        amount: 10, unit: 'NOS', gst_rate: 18 }]
    }, token);
    assert.notStrictEqual(afterDeleteBill.bill.bill_number, inclusiveBill.bill.bill_number);

    const bankImport = await request('POST', '/business/bank-statements/import', {
      org_id: regularOrg.id, file_name: 'statement.xlsx',
      rows: [{ transaction_date: '2026-06-06', description: 'Deposit', reference: 'ABC123',
        debit: 0, credit: 500, balance: 500 }]
    }, token);
    assert.strictEqual(bankImport.imported, 1);
    const statementRows = await request('GET', `/business/bank-statements?org_id=${regularOrg.id}`, undefined, token);
    assert.strictEqual(statementRows.length, 1);
    assert.strictEqual(statementRows[0].reference, 'ABC123');

    console.log('New feature integration tests passed');
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
  console.error(serverOutput);
  process.exitCode = 1;
});
