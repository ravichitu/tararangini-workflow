# Recorded Upgrade: Payment Voucher Editing And Excess Receipt Handling

Status: Recorded for approval and implementation. No functional code changes are included in this record.

## 1. Owner And Operator Permission Rules

- Owner role can edit saved Payment Received vouchers and Payment Vouchers.
- Every owner edit must require a correction reason before saving.
- The original voucher number and transaction identity remain unchanged.
- The edit must write an audit record containing old values, new values, owner ID, timestamp, organization ID, and correction reason.
- Operators, engineers, and other non-owner roles must not see or use the edit action for payment vouchers.
- Operators may view permitted voucher history but cannot alter, delete, or reallocate a saved voucher.
- Financial-year locks, organization access, and company isolation remain enforced during edits.
- Reposting must replace the linked accounting journal safely so the ledger never contains both the old and new posting.

## 2. Payment Received Voucher Edit Fields

Owner correction may edit, subject to validation:

- Payment date
- Party/customer
- Payment mode
- Deposit/payment ledger
- Amount received
- Bank/UPI/card reference
- Linked bill allocations
- Narration

The system must validate the edited party and all linked bills against the selected organization. A voucher from one company must never be editable against another company's party or invoice.

## 3. Excess Receipt Treatment

Example: invoice outstanding is Rs. 1,000 and customer pays Rs. 1,200.

- Allocate only Rs. 1,000 to the invoice.
- Mark the invoice fully paid.
- Record Rs. 200 as `Unallocated Customer Credit` / `Advance from Customer` against the same party ledger.
- Display the excess amount on the saved voucher and party statement.
- The next bill for that party can use the Rs. 200 credit automatically or allow the owner to select it.
- If the customer requests a refund, record a separate owner-approved refund transaction; never silently delete the credit.
- If no party is selected, the system must not hide the excess in an untraceable account; require a party or show a clear owner warning.

Accounting treatment for a customer receipt:

- Debit: selected cash/bank/UPI ledger for the full amount received.
- Credit: Accounts Receivable for the invoice allocation.
- Credit: Customer Advance / Unallocated Receipt liability for the excess amount.

The party statement must show the full receipt credit, the bill allocation, and the remaining customer credit separately.

## 4. User Interface Changes

- Add `Edit` beside saved vouchers only for owners.
- Do not render the edit button for operator accounts.
- On edit, open the voucher with the original values and show an `Edit Reason` field.
- Show a clear allocation summary:
  - Receipt amount
  - Amount allocated to selected bills
  - Excess customer credit
- When a selected bill is already fully paid, allow the owner to keep the excess as customer credit instead of showing a blocking error.
- Add a customer-credit balance indicator in the party ledger and next-bill payment allocation screen.

## 5. Data And API Requirements

The implementation should store explicit fields for:

- `unallocated_amount`
- `excess_treatment` such as `CUSTOMER_CREDIT`, `REFUND_PENDING`, or `NONE`
- `edited_by`
- `edited_at`
- `edit_reason`

Payment allocation rows must be replaced atomically during an owner edit. The linked accounting journal must be reposted atomically after the payment and allocations are updated.

## 6. Tests Required Before Release

- Owner can edit a Payment Received voucher with a reason.
- Owner can edit a Payment Voucher with a reason.
- Operator receives HTTP 403 and has no edit control in the UI.
- Edit without a reason is rejected.
- Cross-company party or invoice assignment is rejected.
- Receipt equal to invoice balance closes the invoice.
- Receipt greater than invoice balance succeeds and stores the excess as customer credit.
- Customer credit appears in the party statement.
- Customer credit can be applied to the next invoice.
- Duplicate edit/retry does not duplicate journal entries.
- Financial-year locked voucher remains protected.
- Backup and restore preserve voucher edits, allocations, audit reason, and customer credit.

## Suggested Implementation Order

1. Add migration fields and accounting account for customer advances.
2. Implement server-side owner-only edit endpoint with atomic allocation and journal reposting.
3. Change excess allocation validation to cap bill allocation and record the remainder as customer credit.
4. Add owner-only voucher edit UI and operator hiding/403 behavior.
5. Add party-ledger and next-bill credit application.
6. Run focused payment/accounting tests, then the complete regression suite before building an installer.
