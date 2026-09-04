# Tarangini Workflow Suite 1.2.3

## Fixes

- Replaces stale customer and desktop web-shell caches after an application update.
- Makes the time-based welcome and sign-off greeting visible immediately on slower client computers and legacy renderers.
- Gives transaction entry screens a full-width Focus Mode with a temporary `Show menu` control.
- Reorganizes Sale Bill entry around the customer and item grid, with date, invoice number, company, and payment mode in the command header.
- Moves optional PO, credit, delivery, courier, split-payment, and signing fields into an `F4` details drawer without changing stored field IDs.
- Preserves entered line breaks in Sale, Quotation, Delivery Challan, Proforma, and Project Printing descriptions when previewed or printed.
- Applies safe business-text capitalization while excluding GSTIN, PAN, HSN, serial, tracking, invoice, phone, email, and reference identifiers.
- Keeps dynamically added Delivery Challan item rows in Delivery Challan mode.

## Compatibility

- The layout is responsive on desktop, tablet, and mobile browsers.
- Existing transaction edit, duplicate, conversion, draft, numbering, company-switch, tax, and audit behavior remains connected to the original fields.

## Update behavior

- Existing 1.2.2 installations can use `Tarangini Billing > Check for Web Updates`, then choose the verified download and restart when prompted.
- The update does not modify accounting data, job data, attachments, or offline queues.
