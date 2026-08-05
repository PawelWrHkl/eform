'use strict';

/** Testy numeracji: wzorce, okresy licznika, walidacja, atomowość rezerwacji. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatNumber,
  resolvePeriodKey,
  validatePattern,
  NumberingService,
  DEFAULT_PATTERNS
} = require('../core/numbering');
const { canTransition, assertTransition, isOverdue } = require('../core/statuses');
const { InvoiceStatus } = require('../domain/constants');

test('wzorce: podstawianie znaczników', () => {
  assert.equal(
    formatNumber({ pattern: 'FV/{YYYY}/{MM}/{NR}', sequence: 17, isoDate: '2026-08-05' }),
    'FV/2026/08/17'
  );
  assert.equal(
    formatNumber({ pattern: 'INV/{ORG}/{YYYY}/{NR:5}', sequence: 17, isoDate: '2026-08-05', orgCode: 'HKL' }),
    'INV/HKL/2026/00017'
  );
  assert.equal(
    formatNumber({ pattern: '{TYPE}-{YY}{MM}{DD}-{NR:3}', sequence: 3, isoDate: '2026-08-05', typeCode: 'advance' }),
    'advance-260805-003'
  );
});

test('okres licznika wynika ze wzorca, nie z założenia', () => {
  assert.equal(resolvePeriodKey('FV/{YYYY}/{MM}/{NR}', '2026-08-05'), '2026-08', 'wzorzec z miesiącem → licznik miesięczny');
  assert.equal(resolvePeriodKey('FV/{YYYY}/{NR}', '2026-08-05'), '2026', 'tylko rok → licznik roczny');
  assert.equal(resolvePeriodKey('FV/{NR:6}', '2026-08-05'), 'all', 'bez daty → numeracja ciągła');
  assert.equal(resolvePeriodKey('FV/{YYYY}{MM}{DD}/{NR}', '2026-08-05'), '2026-08-05', 'z dniem → licznik dzienny');
});

test('walidacja: wzorzec bez licznika jest odrzucany', () => {
  assert.equal(validatePattern('FV/{YYYY}/{MM}/{NR}').valid, true);
  const noCounter = validatePattern('FV/{YYYY}/{MM}');
  assert.equal(noCounter.valid, false, 'brak {NR} oznaczałby duplikaty numerów');
  assert.match(noCounter.error, /licznika/);
  assert.equal(validatePattern('').valid, false);
  assert.equal(validatePattern('FV/{ROK}/{NR}').valid, false, 'nieznany znacznik → błąd, nie ciche podstawienie');
});

test('NumberingService: numer składa się z zarezerwowanej sekwencji', async () => {
  const calls = [];
  const service = new NumberingService({
    allocateSequence: async (params) => {
      calls.push(params);
      return 42;
    }
  });

  const result = await service.next({
    organizationId: 3,
    documentType: 'invoice',
    isoDate: '2026-08-05',
    pattern: 'FV/{YYYY}/{MM}/{NR:4}',
    orgCode: 'HKL'
  });

  assert.equal(result.number, 'FV/2026/08/0042');
  assert.equal(result.sequence, 42);
  assert.deepEqual(calls, [{ organizationId: 3, documentType: 'invoice', periodKey: '2026-08' }]);
});

test('NumberingService: brak wzorca organizacji → wzorzec domyślny typu dokumentu', async () => {
  const service = new NumberingService({ allocateSequence: async () => 1 });
  const result = await service.next({ organizationId: 1, documentType: 'correction', isoDate: '2026-08-05' });
  assert.equal(result.pattern, DEFAULT_PATTERNS.correction);
  assert.equal(result.number, 'KOR/2026/08/1');
});

test('NumberingService: równoległe wywołania nie dostają tego samego numeru', async () => {
  // Atrapa licznika naśladuje `INSERT … ON DUPLICATE KEY UPDATE LAST_INSERT_ID(last+1)`
  let counter = 0;
  const service = new NumberingService({ allocateSequence: async () => { counter += 1; return counter; } });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => service.next({ organizationId: 1, documentType: 'invoice', isoDate: '2026-08-05' }))
  );
  const numbers = results.map((r) => r.number);
  assert.equal(new Set(numbers).size, 5, 'każde wystawienie musi dostać unikalny numer');
});

test('NumberingService wymaga wstrzyknięcia allocateSequence', () => {
  assert.throws(() => new NumberingService({}), /allocateSequence/);
});

test('statusy: dozwolone i zabronione przejścia', () => {
  assert.equal(canTransition(InvoiceStatus.DRAFT, InvoiceStatus.ISSUED), true);
  assert.equal(canTransition(InvoiceStatus.ISSUED, InvoiceStatus.PAID), true);
  assert.equal(canTransition(InvoiceStatus.PAID, InvoiceStatus.DRAFT), false, 'zapłaconej faktury nie cofamy do szkicu');
  assert.equal(canTransition(InvoiceStatus.PAID, InvoiceStatus.CORRECTED), true, 'zapłacona faktura podlega korekcie');
  assert.equal(canTransition(InvoiceStatus.CANCELLED, InvoiceStatus.ISSUED), false);
  assert.throws(() => assertTransition(InvoiceStatus.CORRECTED, InvoiceStatus.PAID), /Niedozwolona zmiana statusu/);
});

test('statusy: przekroczony termin płatności', () => {
  const invoice = { status: InvoiceStatus.ISSUED, dueDate: '2026-08-01' };
  assert.equal(isOverdue(invoice, new Date('2026-08-05T10:00:00')), true);
  assert.equal(isOverdue(invoice, new Date('2026-08-01T10:00:00')), false, 'w dniu terminu jeszcze nie ma zaległości');
  assert.equal(isOverdue({ status: InvoiceStatus.PAID, dueDate: '2026-08-01' }, new Date('2026-09-01')), false);
});
