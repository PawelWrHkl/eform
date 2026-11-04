/**
 * Alternatywy dla niedostępnej tkaniny (API agentai przez
 * `/position/fabric-alternatives/:groupNr`). Czyste funkcje bez DOM — UI jest
 * w dialogUtils_copy.js `showAlternatives`.
 */

// Kod i lista muszą do siebie pasować: kafelek z ALIAS pokazuje kod z listy
// klienta (`paramdict-KOLOR-LUXAN2024.txt` → `LUXAN2024`), bez ALIAS — kod HKL
// własnej listy formatki (API: `HKL`). Tak jest też przy zaślepce
// `paramdict-KOLOR--.txt` z prod.txt, która aliasów nie nakłada.
export function alternativesQuery(option, aliasFile) {
  if (!option.ALIAS || !aliasFile) return { code: option.VALUE, list: 'HKL' };
  return { code: option.ALIAS, list: aliasFile.replace(/\.txt$/i, '').split('-').pop() };
}

// API zna stan z ostatniej synchronizacji PCB i nie rozpoznaje kuponowych —
// odsiewamy je stanem E-Formu (STAN/OBSOLETE/ATTR_DESC z getUniqueCategories),
// razem z kodami, których klient nie ma w tym oknie wyboru. `code` z API to
// kod z listy klienta, czyli ALIAS (przy liście HKL — VALUE).
export function pickAvailableAlternatives(alternatives, options, limit = 5) {
  const byCode = new Map(options.map(option => [option.ALIAS || option.VALUE, option]));
  return (alternatives || [])
    .map(alternative => ({ alternative, option: byCode.get(alternative.code) }))
    .filter(({ option }) => option
      && !option.OBSOLETE
      && !/ZERO|COUPON/i.test(String(option.STAN ?? ''))
      && !String(option.ATTR_DESC ?? '').includes('KUPON'))
    .slice(0, limit);
}

// Progi ΔE z opisu API: 0-2 prawie ten sam, 2-5 bardzo bliski, 5-10 podobny.
export function shadeKey(deltaE) {
  if (typeof deltaE !== 'number' || deltaE > 10) return null;
  if (deltaE < 2) return 'form.alternatives_shade_same';
  return deltaE < 5 ? 'form.alternatives_shade_close' : 'form.alternatives_shade_similar';
}
