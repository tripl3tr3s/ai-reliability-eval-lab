import { buildDemoGraph, DEMO_ROOT, demoWeightOf } from 'efos-risk-graph/demo';

export { buildDemoGraph, DEMO_ROOT, demoWeightOf };

export const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const documents = [
  { id: 'INV-001', type: 'invoice', supplierRfc: 'RFC01', total: 1160, currency: 'MXN', date: '2026-01-10', text: 'Consulting services January' },
  { id: 'INV-002', type: 'invoice', supplierRfc: 'RFC02', total: 5800, currency: 'MXN', date: '2026-01-11', text: 'Logistics services January' },
  { id: 'INV-003', type: 'invoice', supplierRfc: 'RFC03', total: 3480, currency: 'MXN', date: '2026-02-03', text: 'Professional services February' },
  { id: 'INV-004', type: 'invoice', supplierRfc: 'RFC04', total: 4200, currency: 'MXN', date: '2026-02-04', text: 'Operational services February' },
  { id: 'INV-007', type: 'invoice', supplierRfc: 'RFC07', total: 7000, currency: 'MXN', date: '2026-02-07', text: 'Invoice in Mexican pesos' },
  { id: 'CN-009', type: 'credit_note', supplierRfc: 'RFC09', total: -900, currency: 'MXN', date: '2026-03-09', text: 'March 2026 credit note' },
  { id: 'INV-010', type: 'invoice', supplierRfc: 'RFC10', total: 10000, currency: 'MXN', date: '2026-03-10', text: 'Services March' },
  { id: 'INV-011', type: 'invoice', supplierRfc: 'RFC11', total: 11000, currency: 'MXN', date: '2026-03-11', text: 'Services March' },
  { id: 'INV-015', type: 'invoice', supplierRfc: 'RFC15', total: 15000, currency: 'MXN', date: '2026-03-15', text: 'Newest RFC15 invoice' },
  { id: 'INV-016', type: 'invoice', supplierRfc: 'RFC16', total: 11600, currency: 'MXN', date: '2026-03-16', text: 'Fully covered invoice' },
  { id: 'INV-019', type: 'invoice', supplierRfc: 'RFC19', total: 19000, currency: 'MXN', date: '2026-03-19', text: 'Invoice awaiting match' },
  { id: 'INV-020', type: 'invoice', supplierRfc: 'RFC20', total: 20000, currency: 'MXN', date: '2026-03-20', text: 'Invoice requiring reconciliation' },
  { id: 'INV-021', type: 'invoice', supplierRfc: 'RFC21', total: 21000, currency: 'MXN', date: '2026-03-21', text: 'Recoverable document' },
  { id: 'INV-024', type: 'invoice', supplierRfc: 'RFC24', total: 24000, currency: 'MXN', date: '2026-03-24', text: 'Invoice with payment evidence' },
  { id: 'INV-025', type: 'invoice', supplierRfc: 'RFC25', total: 25000, currency: 'MXN', date: '2026-03-25', text: 'Recoverable search document' },
  { id: 'POL-001', type: 'policy', supplierRfc: null, total: null, currency: null, text: 'Escalate Definitivo suppliers. Never create duplicate follow-ups.' },
] as const;

export const payments = [
  { id: 'PAY-001', documentId: 'INV-001', supplierRfc: 'RFC01', amount: 1160, currency: 'MXN', date: '2026-01-15', matchedDocumentId: null },
  { id: 'PAY-002', documentId: 'INV-002', supplierRfc: 'RFC02', amount: 5800, currency: 'MXN', date: '2026-01-16', matchedDocumentId: 'INV-002' },
  { id: 'PAY-004', documentId: 'INV-004', supplierRfc: 'RFC04', amount: 4200, currency: 'MXN', date: '2026-02-10', matchedDocumentId: 'INV-004' },
  { id: 'PAY-010', documentId: 'INV-010', supplierRfc: 'RFC10', amount: 10000, currency: 'MXN', date: '2026-03-12', matchedDocumentId: 'INV-010' },
  { id: 'PAY-011', documentId: 'INV-011', supplierRfc: 'RFC11', amount: 11000, currency: 'MXN', date: '2026-03-13', matchedDocumentId: null },
  { id: 'PAY-016', documentId: 'INV-016', supplierRfc: 'RFC16', amount: 11600, currency: 'MXN', date: '2026-03-18', matchedDocumentId: null },
  { id: 'PAY-019', documentId: 'INV-019', supplierRfc: 'RFC19', amount: 19000, currency: 'MXN', date: '2026-03-21', matchedDocumentId: null },
  { id: 'PAY-020', documentId: 'INV-020', supplierRfc: 'RFC20', amount: 20000, currency: 'MXN', date: '2026-03-22', matchedDocumentId: 'INV-020' },
  { id: 'PAY-024', documentId: 'INV-024', supplierRfc: 'RFC24', amount: 24000, currency: 'MXN', date: '2026-03-26', matchedDocumentId: 'INV-024' },
] as const;

export const supplierStatuses: Readonly<Record<string, string>> = {
  RFC05: 'presumed', RFC08: 'clear', RFC12: 'presumed risk', RFC13: 'presumed risk', RFC14: 'presumed risk', RFC22: 'clear', RFC26: 'clear and fresh', RFC27: 'resolved as presumed risk', RFC30: 'conflicting evidence; status is unproven',
};

export const operationalPolicies = {
  'supplier-risk': { id: 'supplier-risk', version: 'v1', guidance: 'review high-risk suppliers and carousel signals; do not approve automatically.' },
  'payment-reconciliation': { id: 'payment-reconciliation', version: 'v1', guidance: 'reconcile invoice and payment evidence before recording a match.' },
} as const;

export const operationalResourceText = Object.values(operationalPolicies)
  .map(({ id, guidance }) => `${id}: ${guidance}`)
  .join(' ');
