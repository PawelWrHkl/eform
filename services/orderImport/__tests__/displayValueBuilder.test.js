'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDisplayValuesFromDictionary } = require('../displayValueBuilder');

function fakeRepo(dict) {
  return {
    async getGroupTranslations() {
      return dict;
    }
  };
}

test('builds display values from translation dictionary params and paramdict', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '43',
    lang: 'de',
    values: {
      MODEL: 'VS1',
      KOLOR: '3002-P20',
      KOLOR_ALIAS: '2002-P20',
      KOLOR___DESCRIPTION: 'PG #1',
      SZEROKOSC: 1232,
      MODEL___VISIBLE: true,
      KOLOR___VISIBLE: true,
      SZEROKOSC___VISIBLE: true
    },
    repo: fakeRepo({
      params: {
        MODEL: 'MODELL',
        KOLOR: 'STOFF',
        SZEROKOSC: 'BREITE [MM]'
      },
      paramdict: {
        MODEL: { VS1: 'Verspannt' },
        KOLOR: { '3002-P20': 'PG #1' }
      }
    })
  });

  assert.deepEqual(out.MODEL, {
    param_description: 'MODELL',
    sub: false,
    option_value: 'VS1',
    option_description: 'Verspannt',
    locked: false,
    row: '1'
  });
  assert.equal(out.KOLOR.param_description, 'STOFF');
  assert.equal(out.KOLOR.option_value, '2002-P20');
  assert.equal(out.KOLOR.option_description, 'PG #1');
  assert.equal(out.SZEROKOSC.option_value, '1232');
  assert.equal(out.SZEROKOSC.option_description, '');
  assert.equal(out.KOLOR___DESCRIPTION, undefined);
});

test('empties the "<NULL>" sentinel so roof dimensions do not duplicate on the price row', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '39',
    lang: 'nl',
    values: {
      SZEROKOSC: 590,
      SZEROKOSC_DACH: '<NULL>'
    },
    displayValues: {
      SZEROKOSC: { param_description: 'BREEDTE [MM]', option_value: '590', locked: false, row: '1' },
      SZEROKOSC_DACH: { param_description: 'BREEDTE [MM]', option_value: '<NULL>', locked: false, row: '2' }
    },
    formMeta: {
      params: [
        { NAME: 'SZEROKOSC', LISTROW: '1', FORMROW: '1' },
        { NAME: 'SZEROKOSC_DACH', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: [],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: { SZEROKOSC: 'BREEDTE [MM]', SZEROKOSC_DACH: 'BREEDTE [MM]' },
      paramdict: {}
    })
  });

  // The real width stays on row 1; the "<NULL>" placeholder on the price row is
  // emptied so the template no longer renders a duplicate BREEDTE with no value.
  assert.equal(out.SZEROKOSC.option_value, '590');
  assert.equal(out.SZEROKOSC.row, '1');
  assert.equal(out.SZEROKOSC_DACH.option_value, '');
  assert.equal(out.SZEROKOSC_DACH.row, '2');
});

test('mirrors the row and empty value the form assigned to an invisible price field', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '43',
    lang: 'de',
    values: {
      CENA: 276,
      CENA___VISIBLE: false
    },
    displayValues: {
      CENA: { locked: false, row: '0' }
    },
    formMeta: {
      params: [{ NAME: 'CENA', LISTROW: '2', FORMROW: '1' }],
      lockedParams: [],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: { CENA: 'LISTENPREIS [€]' },
      paramdict: {}
    })
  });

  // The form left this price hidden (row 0, no computed value). We translate the
  // label but never promote the row or refill the value the form intentionally
  // cleared, so the template hides it exactly as the browser does.
  assert.equal(out.CENA.param_description, 'LISTENPREIS [€]');
  assert.ok(!out.CENA.option_value);
  assert.equal(out.CENA.row, '0');
  assert.equal(out.CENA.locked, false);
});

test('marks invisible config fields with row 0 and preserves existing engine flags', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '43',
    lang: 'de',
    values: {
      MODEL: 'VS1',
      MODEL___VISIBLE: false
    },
    displayValues: {
      MODEL: { locked: false }
    },
    formMeta: {
      params: [{ NAME: 'MODEL', LISTROW: '1', FORMROW: '1' }],
      lockedParams: [],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: { MODEL: 'MODELL' },
      paramdict: { MODEL: { VS1: 'Verspannt' } }
    })
  });

  assert.equal(out.MODEL.row, '0');
  assert.equal(out.MODEL.option_value, 'VS1');
});

test('uses form metadata for row, listsum, locked and sub flags', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '43',
    lang: 'de',
    values: {
      CENA: 276,
      CENA_RABAT: 200,
      SUB___CENA_RABAT: 180
    },
    formMeta: {
      params: [
        { NAME: 'CENA', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' },
        { NAME: 'CENA_RABAT', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' },
        { NAME: 'SUB___CENA_RABAT', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' }
      ],
      lockedParams: ['CENA_RABAT'],
      subParams: ['SUB___CENA_RABAT'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        CENA: 'LISTENPREIS [€]',
        CENA_RABAT: 'RABATT',
        SUB___CENA_RABAT: 'SUB RABATT'
      },
      paramdict: {}
    })
  });

  assert.equal(out.CENA.row, '2');
  assert.equal(out.CENA.listsum, true);
  assert.equal(out.CENA.locked, false);
  assert.equal(out.CENA_RABAT.row, '2');
  assert.equal(out.CENA_RABAT.listsum, true);
  assert.equal(out.CENA_RABAT.locked, true);
  assert.equal(out.SUB___CENA_RABAT.sub, true);
  assert.equal(out.SUB___CENA_RABAT.locked, true);
});

test('keeps list row for locked fields even when visible flag is false', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '43',
    lang: 'de',
    values: {
      CENA_RABAT: 200,
      CENA_RABAT___VISIBLE: false
    },
    formMeta: {
      params: [{ NAME: 'CENA_RABAT', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' }],
      lockedParams: ['CENA_RABAT'],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: { CENA_RABAT: 'RABATT' },
      paramdict: {}
    })
  });

  assert.equal(out.CENA_RABAT.locked, true);
  assert.equal(out.CENA_RABAT.row, '2');
});

test('keeps form-emitted params and never synthesizes surcharges the form omitted', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'de',
    values: {
      MODEL: 'H50',
      DOPLATA_EL: 12.5,
      SUB___DOPLATA_EL: 15,
      CENA_RABAT: 0
    },
    displayValues: [
      ['CENA_RABAT', {
        param_description: 'RABATT',
        option_value: '0%',
        locked: true,
        row: '2'
      }]
    ],
    importValues: {
      MODEL: 'H50',
      DOPLATA_EL: 12.5,
      SUB___DOPLATA_EL: 15
    },
    formMeta: {
      params: [
        { NAME: 'DOPLATA_EL', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___DOPLATA_EL', LISTROW: '2', FORMROW: '1' },
        { NAME: 'CENA_RABAT', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: ['CENA_RABAT'],
      subParams: ['SUB___DOPLATA_EL'],
      skipCountParams: ['DOPLATA_EL', 'SUB___DOPLATA_EL', 'DOPLATA_EL_RABAT', 'SUB___DOPLATA_EL_RABAT']
    },
    repo: fakeRepo({
      params: {
        DOPLATA_EL: 'AUFPREIS EL[€] brutto',
        SUB___DOPLATA_EL: 'AUFPREIS EL[€] brutto',
        CENA_RABAT: 'RABATT'
      },
      paramdict: {}
    })
  });

  // CENA_RABAT is the only param the form actually emitted, so it survives with
  // its computed flags. The surcharge params live only in `values`/formMeta, so
  // the faithful builder does not invent display rows the form never produced.
  assert.equal(out.CENA_RABAT.option_value, '0%');
  assert.equal(out.CENA_RABAT.locked, true);
  assert.equal(out.CENA_RABAT.row, '2');
  assert.equal(out.DOPLATA_EL, undefined);
  assert.equal(out.DOPLATA_EL_RABAT, undefined);
  assert.equal(out.SUB___DOPLATA_EL, undefined);
  assert.equal(out.SUB___DOPLATA_EL_RABAT, undefined);
});

test('keeps the engine locked flag on EL_RABAT params instead of forcing it', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      DOPLATA_EL_RABAT: 0,
      SUB___DOPLATA_EL_RABAT: 0
    },
    displayValues: [
      ['DOPLATA_EL_RABAT', {
        param_description: 'KORTING EL',
        option_value: '0%',
        locked: false,
        row: '2'
      }],
      ['SUB___DOPLATA_EL_RABAT', {
        param_description: 'KORTING EL SUB',
        option_value: '0%',
        locked: false,
        sub: true,
        row: '2'
      }]
    ],
    formMeta: {
      params: [
        { NAME: 'DOPLATA_EL_RABAT', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___DOPLATA_EL_RABAT', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: [],
      subParams: ['SUB___DOPLATA_EL_RABAT'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        DOPLATA_EL_RABAT: 'KORTING EL',
        SUB___DOPLATA_EL_RABAT: 'KORTING EL SUB'
      },
      paramdict: {}
    })
  });

  // The form stored these as unlocked (locked:false). We mirror that faithfully
  // rather than forcing locked:true as the old heuristic did.
  assert.equal(out.DOPLATA_EL_RABAT.locked, false);
  assert.equal(out.DOPLATA_EL_RABAT.row, '2');
  assert.equal(out.DOPLATA_EL_RABAT.option_value, '0%');
  assert.equal(out.SUB___DOPLATA_EL_RABAT.locked, false);
  assert.equal(out.SUB___DOPLATA_EL_RABAT.sub, true);
  assert.equal(out.SUB___DOPLATA_EL_RABAT.row, '2');
});

test('omits zero DOPLATA and matching SUB___ surcharge fields from displayValues', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      MODEL: 'H50',
      DOPLATA: 0,
      DOPLATA_S: '0(SF50)',
      SUB___DOPLATA: 0,
      SUB___DOPLATA_S: '0(SF50)',
      CENA: 59.43
    },
    displayValues: [
      ['CENA', {
        param_description: 'CATALOGUSPRIJS',
        option_value: '59.43',
        locked: false,
        row: '2'
      }]
    ],
    formMeta: {
      params: [
        { NAME: 'DOPLATA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___DOPLATA', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: ['DOPLATA_S', 'SUB___DOPLATA_S'],
      subParams: ['SUB___DOPLATA', 'SUB___DOPLATA_S'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        DOPLATA: 'MEERPRIJS',
        SUB___DOPLATA: 'MEERPRIJS SUB',
        CENA: 'CATALOGUSPRIJS'
      },
      paramdict: {}
    })
  });

  assert.equal(out.DOPLATA, undefined);
  assert.equal(out.DOPLATA_S, undefined);
  assert.equal(out.SUB___DOPLATA, undefined);
  assert.equal(out.SUB___DOPLATA_S, undefined);
  assert.equal(out.CENA.option_value, '59.43');
});

test('keeps every param the form emitted, including empty config and zero surcharges', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      MODEL: 'H50',
      DOPLATA_EL: 0,
      SUB___DOPLATA_EL: 0,
      SUB___DOPLATA_EL_RABAT: 0,
      CENA: 59.43
    },
    displayValues: [
      ['MOTOR', { param_description: 'MOTOR', option_value: '', row: '1', locked: false, sub: false }],
      ['WYMIAROWANIE_SLOPOW', {
        param_description: 'AFMETINGEN VOOR SLOPE [MM]',
        option_value: '',
        row: '1',
        locked: false,
        sub: false
      }],
      ['DOPLATA_EL', {
        param_description: 'PRIJS VOOR EL INCLUSIEF BTW [€]',
        option_value: '0',
        row: '2',
        locked: false,
        sub: false
      }],
      ['SUB___DOPLATA_EL', {
        param_description: 'PRIJS VOOR EL INCLUSIEF BTW [€]',
        option_value: '0',
        row: '2',
        locked: false,
        sub: true
      }],
      ['SUB___DOPLATA_EL_RABAT', {
        param_description: 'KORTING OP DE ADVIESVERKOOPPRIJS VOOR EL',
        option_value: '0',
        row: '2',
        locked: true,
        sub: true
      }],
      ['CENA_RABAT_S', {
        param_description: 'CENA_RABAT_S',
        option_value: '',
        row: '2',
        locked: true,
        sub: false
      }],
      ['CENA', {
        param_description: 'CATALOGUSPRIJS',
        option_value: '59.43',
        row: '2',
        locked: false,
        sub: false
      }]
    ],
    formMeta: {
      params: [
        { NAME: 'MOTOR', LISTROW: '1', FORMROW: '1' },
        { NAME: 'WYMIAROWANIE_SLOPOW', LISTROW: '1', FORMROW: '1' },
        { NAME: 'DOPLATA_EL', LISTROW: '2', FORMROW: '1' },
        { NAME: 'CENA', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: ['CENA_RABAT_S', 'SUB___DOPLATA_EL_RABAT'],
      subParams: ['SUB___DOPLATA_EL', 'SUB___DOPLATA_EL_RABAT'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        MOTOR: 'MOTOR',
        WYMIAROWANIE_SLOPOW: 'AFMETINGEN VOOR SLOPE [MM]',
        DOPLATA_EL: 'PRIJS VOOR EL INCLUSIEF BTW [€]',
        CENA: 'CATALOGUSPRIJS'
      },
      paramdict: { MODEL: { H50: '50 MM HOUTEN JALOEZIEËN' } }
    })
  });

  // Every entry the form emitted is mirrored: empty config stays empty (the
  // template hides it), zero surcharges keep their row/locked flags, and CENA
  // keeps its price. MODEL is absent from the form output, so it is not invented.
  assert.equal(out.MOTOR.option_value, '');
  assert.equal(out.MOTOR.row, '1');
  assert.equal(out.WYMIAROWANIE_SLOPOW.option_value, '');
  assert.equal(out.DOPLATA_EL.option_value, '0');
  assert.equal(out.DOPLATA_EL.row, '2');
  assert.equal(out.SUB___DOPLATA_EL.option_value, '0');
  assert.equal(out.SUB___DOPLATA_EL_RABAT.locked, true);
  assert.equal(out.SUB___DOPLATA_EL_RABAT.row, '2');
  assert.equal(out.CENA_RABAT_S.option_value, '');
  assert.equal(out.CENA.option_value, '59.43');
  assert.equal(out.MODEL, undefined);
});

test('keeps row 0 params when they carry displayable content', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'de',
    values: {
      OPIS_POZYCJI: 'MODEL=H50,MONTAZ=307',
      OPIS_CENY: 'CENA=100'
    },
    repo: fakeRepo({
      params: {
        OPIS_POZYCJI: 'OPIS_POZYCJI',
        OPIS_CENY: 'OPIS_CENY'
      },
      paramdict: {}
    })
  });

  assert.equal(out.OPIS_POZYCJI.option_value, 'MODEL=H50,MONTAZ=307');
  assert.equal(out.OPIS_CENY.option_value, 'CENA=100');
  assert.notEqual(out.OPIS_POZYCJI, undefined);
  assert.notEqual(out.OPIS_CENY, undefined);
});

test('preserves engine price rows, locked flags and computed display values over import', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'de',
    values: {
      MODEL: 'H50',
      CENA: 138.88,
      CENA_RABAT: 0,
      SUB___CENA: 481,
      SUB___CENA_RABAT: 0,
      SUMA_BRUTTO: 149.58
    },
    displayValues: [
      ['CENA', {
        param_description: 'LISTENPREIS [€]',
        option_value: '138.88',
        option_description: '',
        locked: false,
        row: '2'
      }],
      ['CENA_RABAT', {
        param_description: 'RABATT',
        option_value: '0%',
        option_description: '',
        locked: true,
        row: '2'
      }],
      ['SUB___CENA', {
        param_description: 'LISTENPREIS [€]',
        option_value: '481',
        option_description: '',
        locked: false,
        sub: true,
        row: '2'
      }],
      ['SUB___CENA_RABAT', {
        param_description: 'RABATT',
        option_value: '0%',
        option_description: '',
        locked: true,
        sub: true,
        row: '2'
      }],
      ['SUMA_BRUTTO', {
        param_description: 'GES.WERT [€]',
        option_value: '149.58',
        option_description: '',
        locked: false,
        row: '2',
        listsum: true
      }]
    ],
    importValues: {
      MODEL: 'H50',
      CENA: 100,
      CENA_RABAT: 0,
      SUB___CENA: 400
    },
    formMeta: {
      params: [
        { NAME: 'MODEL', LISTROW: '1', FORMROW: '1' },
        { NAME: 'CENA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'CENA_RABAT', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___CENA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___CENA_RABAT', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUMA_BRUTTO', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' }
      ],
      lockedParams: ['CENA_RABAT', 'SUB___CENA_RABAT'],
      subParams: ['SUB___CENA', 'SUB___CENA_RABAT'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        MODEL: 'MODELL',
        CENA: 'LISTENPREIS [€]',
        CENA_RABAT: 'RABATT',
        SUB___CENA: 'LISTENPREIS [€]',
        SUB___CENA_RABAT: 'RABATT',
        SUMA_BRUTTO: 'GES.WERT [€]'
      },
      paramdict: { MODEL: { H50: '50 MM HOLZJALOUSIE' } }
    })
  });

  assert.equal(out.CENA.row, '2');
  assert.equal(out.CENA.option_value, '138.88');
  assert.equal(out.CENA_RABAT.locked, true);
  assert.equal(out.CENA_RABAT.option_value, '0%');
  assert.equal(out.SUB___CENA.sub, true);
  assert.equal(out.SUB___CENA.option_value, '481');
  assert.equal(out.SUB___CENA_RABAT.locked, true);
  assert.equal(out.SUB___CENA_RABAT.sub, true);
  assert.equal(out.SUMA_BRUTTO.listsum, true);
  assert.equal(out.SUMA_BRUTTO.option_value, '149.58');
  assert.equal(Object.keys(out)[0], 'CENA');
});

test('keeps SUB___ listsum prices at the row the form assigned without promoting them', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      CENA: 59.43,
      CENA_SUMA: 59.43,
      SUMA_BRUTTO: 59.43,
      SUB___CENA: 224,
      SUB___CENA_SUMA: 224,
      SUB___SUMA_BRUTTO: 224,
      SUB___CENA_SUMA___VISIBLE: false,
      SUB___SUMA_BRUTTO___VISIBLE: false
    },
    displayValues: [
      ['SUB___CENA_SUMA', {
        param_description: 'PRIJS INCLUSIEF BTW PER STUK [€]',
        option_value: '224',
        locked: false,
        sub: true,
        row: '0'
      }],
      ['SUB___SUMA_BRUTTO', {
        param_description: 'TOTAALPRIJS INCLUSIEF BTW [€]',
        option_value: '224',
        locked: false,
        sub: true,
        listsum: true,
        row: '0'
      }],
      ['SUB___CENA', {
        param_description: 'CATALOGUSPRIJS INCLUSIEF BTW [€]',
        option_value: '224',
        locked: false,
        sub: true,
        row: '2'
      }]
    ],
    formMeta: {
      params: [
        { NAME: 'SUB___CENA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___CENA_SUMA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___SUMA_BRUTTO', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' }
      ],
      lockedParams: [],
      subParams: ['SUB___CENA', 'SUB___CENA_SUMA', 'SUB___SUMA_BRUTTO'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        SUB___CENA: 'CATALOGUSPRIJS INCLUSIEF BTW [€]',
        SUB___CENA_SUMA: 'PRIJS INCLUSIEF BTW PER STUK [€]',
        SUB___SUMA_BRUTTO: 'TOTAALPRIJS INCLUSIEF BTW [€]'
      },
      paramdict: {}
    })
  });

  // The form left these at row 0 (hidden). We mirror that instead of promoting
  // them to row 2, so the imported view matches what the form shows.
  assert.equal(out.SUB___CENA_SUMA.row, '0');
  assert.equal(out.SUB___CENA_SUMA.option_value, '224');
  assert.equal(out.SUB___CENA_SUMA.sub, true);
  assert.equal(out.SUB___SUMA_BRUTTO.row, '0');
  assert.equal(out.SUB___SUMA_BRUTTO.listsum, true);
  assert.equal(out.SUB___CENA.option_value, '224');
});

test('keeps SUB___ *_S spec fields with sub false', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      SUB___CENA: 224,
      SUB___CENA_S: '224(H50PG0)'
    },
    displayValues: [
      ['SUB___CENA_S', {
        param_description: 'SUB___CENA_S',
        option_value: '224, (H50PG0)',
        locked: true,
        sub: false,
        row: '2'
      }]
    ],
    formMeta: {
      params: [
        { NAME: 'SUB___CENA', LISTROW: '2', FORMROW: '1' },
        { NAME: 'SUB___CENA_S', LISTROW: '2', FORMROW: '1' }
      ],
      lockedParams: ['SUB___CENA_S'],
      subParams: ['SUB___CENA'],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        SUB___CENA: 'CATALOGUSPRIJS',
        SUB___CENA_S: 'SUB___CENA_S'
      },
      paramdict: {}
    })
  });

  assert.equal(out.SUB___CENA_S.sub, false);
  assert.equal(out.SUB___CENA_S.option_value, '224, (H50PG0)');
});

test('preserves the dimensions and config the form emitted', async () => {
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '59',
    lang: 'nl',
    values: {
      SZEROKOSC: 1320,
      WYSOKOSC: 1860,
      SZEROKOSC___VISIBLE: true,
      WYSOKOSC___VISIBLE: true,
      MODEL: 'H50',
      CENA: '276'
    },
    displayValues: {
      SZEROKOSC: { param_description: 'BREEDTE [MM]', option_value: '1320', locked: false, row: '1' },
      WYSOKOSC: { param_description: 'HOOGTE [MM]', option_value: '1860', locked: false, row: '1' },
      MODEL: { param_description: 'MODEL', option_value: 'H50', locked: false, row: '1' },
      CENA: {
        param_description: 'LISTENPREIS [€]',
        option_value: '276',
        option_description: '',
        locked: false,
        row: '2',
        listsum: true
      }
    },
    importValues: {
      SZEROKOSC: 1320,
      WYSOKOSC: 1860,
      MODEL: 'H50',
      KOLOR: '5711-50'
    },
    formMeta: {
      params: [
        { NAME: 'SZEROKOSC', LISTROW: '1', FORMROW: '1' },
        { NAME: 'WYSOKOSC', LISTROW: '1', FORMROW: '1' },
        { NAME: 'MODEL', LISTROW: '1', FORMROW: '1' },
        { NAME: 'KOLOR', LISTROW: '1', FORMROW: '1' },
        { NAME: 'CENA', LISTROW: '2', LISTSUM: 'true', FORMROW: '1' }
      ],
      lockedParams: [],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: {
        SZEROKOSC: 'BREEDTE [MM]',
        WYSOKOSC: 'HOOGTE [MM]',
        MODEL: 'MODEL',
        KOLOR: 'KLEUR',
        CENA: 'LISTENPREIS [€]'
      },
      paramdict: {}
    })
  });

  // The form emitted the dimensions and CENA; each is mirrored faithfully. KOLOR
  // only exists in the raw values (the form did not emit it), so it is not added.
  assert.equal(out.SZEROKOSC.row, '1');
  assert.equal(out.SZEROKOSC.option_value, '1320');
  assert.equal(out.WYSOKOSC.row, '1');
  assert.equal(out.WYSOKOSC.option_value, '1860');
  assert.equal(out.MODEL.option_value, 'H50');
  assert.equal(out.CENA.row, '2');
  assert.equal(out.CENA.option_value, '276');
  assert.equal(out.KOLOR, undefined);
});

test('an import value does not resurrect a field the form disabled (___VISIBLE:false)', async () => {
  // Group 71 / MODEL=BB24: param.txt disables DLUGOSC_STER, so the payload value
  // must not be shown, described or pulled back onto row 1 — while MODEL, an
  // equally "imported" param, keeps all of those privileges.
  const out = await buildDisplayValuesFromDictionary({
    groupNumber: '71',
    lang: 'pl',
    values: {
      MODEL: 'BB24',
      MODEL___VISIBLE: true,
      DLUGOSC_STER: '',
      DLUGOSC_STER___VISIBLE: false
    },
    importValues: { MODEL: 'BB24', DLUGOSC_STER: 800 },
    formMeta: {
      params: [
        { NAME: 'MODEL', LISTROW: '1', FORMROW: '1' },
        { NAME: 'DLUGOSC_STER', LISTROW: '1', FORMROW: '1' }
      ],
      lockedParams: [],
      subParams: [],
      skipCountParams: []
    },
    repo: fakeRepo({
      params: { MODEL: 'MODEL', DLUGOSC_STER: 'DŁUGOŚĆ STEROWANIA [MM]' },
      paramdict: { MODEL: { BB24: 'BB 24' } }
    })
  });

  assert.equal(out.DLUGOSC_STER.option_value, '');
  assert.equal(out.DLUGOSC_STER.option_description, '');
  assert.equal(out.DLUGOSC_STER.row, '0');
  assert.equal(out.MODEL.option_value, 'BB24');
  assert.equal(out.MODEL.row, '1');
});
