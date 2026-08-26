import { buildDemoGraph, DEMO_ROOT, demoWeightOf } from 'efos-risk-graph/demo';

export { buildDemoGraph, DEMO_ROOT, demoWeightOf };

export const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const documents = [
  { id: 'INV-001', type: 'invoice', supplierRfc: 'EFO010101AA1', total: 11600, currency: 'MXN', text: 'Consulting services January' },
  { id: 'INV-002', type: 'invoice', supplierRfc: 'PRO010101AA1', total: 5800, currency: 'MXN', text: 'Logistics services January' },
  { id: 'POL-001', type: 'policy', supplierRfc: null, total: null, currency: null, text: 'Escalate Definitivo suppliers. Never create duplicate follow-ups.' },
] as const;

export const payments = [
  { id: 'PAY-001', supplierRfc: 'EFO010101AA1', amount: 11600, currency: 'MXN', date: '2026-01-15', matchedDocumentId: null },
  { id: 'PAY-002', supplierRfc: 'PRO010101AA1', amount: 5800, currency: 'MXN', date: '2026-01-16', matchedDocumentId: 'INV-002' },
] as const;

export const supplierStatuses: Readonly<Record<string, 'Definitivo' | 'Presunto' | 'Desvirtuado' | 'Unlisted'>> = {
  EFO010101AA1: 'Definitivo', PRE010101AA1: 'Presunto', DES010101AA1: 'Desvirtuado', PRO010101AA1: 'Unlisted',
};

export const operationalPolicy = {
  version: 'v1',
  rules: ['Escalate Definitivo suppliers', 'Require invoice evidence before payment matching', 'Never create duplicate follow-ups'],
} as const;
