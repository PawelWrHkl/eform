'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAxis, completeEnable, baseContext } = require('../index');
const { createRealm } = require('../../formEngine/scriptRunner');

const realm = createRealm();
const evaluate = (f, v) => realm.evaluate(f, v);
const opts = (...values) => values.map((VALUE) => ({ VALUE, DESCRIPTION: VALUE, ENABLE: '', PROC: '' }));

test('resolveAxis: PARAM/10, licznik, stała', () => {
  assert.deepEqual(resolveAxis({ formula: 'SZEROKOSC/10' }, {}), { field: 'SZEROKOSC', scale: 10, fixed: {}, variants: [] });
  assert.equal(resolveAxis({ formula: 'TORY' }, { TORY: opts('2', '3') }).count, true);
  assert.equal(resolveAxis({ str: '' }, {}).literal, true);
});

test('resolveAxis: wariant opcji z przesunięciem (14: VERTI = pasek + 38 mm)', () => {
  const axis = { formula: 'IF(WYS_RODZ="VERTI",(WYSOKOSC-38)/10,WYSOKOSC/10)' };
  const r = resolveAxis(axis, { WYS_RODZ: opts('VERTI', 'PASEK') });
  assert.equal(r.field, 'WYSOKOSC');
  assert.deepEqual(r.fixed, { WYS_RODZ: 'PASEK' });
  assert.deepEqual(r.variants.map((v) => [v.value, v.shiftMm]), [['VERTI', 38]]);
});

test('resolveAxis: wzór sprowadzony wyborem sekcji (46: KONFIGURACJA=N → SZER_PANELU)', () => {
  const axis = { formula: 'IF(KONFIGURACJA="N",SZER_PANELU,IF(KONFIGURACJA="S_N",SZER_PANELU_WYL,IF(ILOSC_PANELI>0,SZEROKOSC/ILOSC_PANELI,0)))/10' };
  const options = { KONFIGURACJA: opts('S_N', 'S', 'N'), ILOSC_PANELI: opts('1', '2', '3') };
  assert.deepEqual(resolveAxis(axis, options, { KONFIGURACJA: 'N' }), { field: 'SZER_PANELU', scale: 10, fixed: {}, variants: [] });
  assert.equal(resolveAxis(axis, options, { KONFIGURACJA: 'S_N' }).field, 'SZER_PANELU_WYL');
  // Sam system: szerokość / liczba paneli — nie jest jednym polem.
  assert.equal(resolveAxis(axis, options, { KONFIGURACJA: 'S' }), null);
});

test('completeEnable: łańcuch wyborów i gałąź OR z ENABLE opcji (73)', () => {
  const params = { KONFIGURACJA: {}, STOFF: {}, MODEL: {}, FALA: {}, TASMA: {} };
  const options = {
    KONFIGURACJA: opts('CFO', 'COM', 'KAR'),
    STOFF: opts('K', 'E'),
    FALA: [{ VALUE: 'V1', ENABLE: '=WSROD(MODEL,"FLEX")' }, { VALUE: 'W60', ENABLE: '=WSROD(MODEL,"WAVE")' }],
    TASMA: opts('G01')
  };
  const ctx = { ...baseContext('u', params), MODEL: 'WAVE' };
  const enable = '=AND(WSROD(KONFIGURACJA,"CFO,COM"),NOT(WSROD(STOFF,"K")),OR(WSROD(FALA,"V1,W60"),WSROD(TASMA,"G01")))';
  assert.deepEqual(completeEnable(enable, ctx, options, evaluate), { KONFIGURACJA: 'CFO', FALA: 'W60' });
  assert.equal(ctx.STOFF, '', 'pusty wybór spełnia już NOT(STOFF=K)');
  // Wybór już ustalony nie jest zmieniany: KAR wyłącza oś i tak ma zostać.
  const kar = { ...baseContext('u', params), KONFIGURACJA: 'KAR', MODEL: 'WAVE' };
  completeEnable(enable, kar, options, evaluate);
  assert.equal(kar.KONFIGURACJA, 'KAR');
  assert.equal(evaluate(enable, kar), false);
});
