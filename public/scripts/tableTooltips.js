/*
 * Dymki (`has-tooltip`) w tabeli zamówienia — renderowane POZA tabelą.
 *
 * ⚠️ Dlaczego JS, a nie samo CSS: dymek jest pseudoelementem przycisku, więc
 * żyje w kontekście stakowania swojej komórki. Przypięte kolumny (`position:
 * sticky` + `z-index`) taki kontekst tworzą, a zmierzone zachowanie obu
 * silników jest takie, że komórka `tbody` — nawet z `z-index: 100001` — maluje
 * się POD komórką `thead`, gdy ta ma jakikolwiek `z-index >= 1`. Żadna wartość
 * z-indeksu na pseudoelemencie tego nie przebije, bo nie da się wyjść poza
 * kontekst rodzica. Dymek trafia więc do `document.body` z pozycjonowaniem
 * `fixed` — tam nie ma nad sobą żadnego kontekstu tabeli i zawsze jest na
 * wierzchu, także nad nagłówkiem i wierszami cen.
 *
 * Dymki poza tabelą (nawigacja, paski akcji) zostają na CSS-owych
 * pseudoelementach — ten moduł obsługuje wyłącznie `.order-table`.
 */
(function () {
  'use strict';

  var ODSTEP = 10;          // odstęp dymka od elementu (px)
  var MARGINES_EKRANU = 8;  // minimalny odstęp od krawędzi okna

  var dymek = null;
  var aktywny = null;

  function utworz() {
    if (dymek) return dymek;
    dymek = document.createElement('div');
    dymek.className = 'table-tooltip';
    dymek.setAttribute('role', 'tooltip');
    document.body.appendChild(dymek);
    return dymek;
  }

  function pozycjonuj(cel) {
    var r = cel.getBoundingClientRect();
    var d = dymek.getBoundingClientRect();

    // Domyślnie NAD elementem — tego oczekuje użytkownik. W dół schodzimy
    // tylko wtedy, gdy nad elementem fizycznie nie ma miejsca w oknie.
    var gora = r.top - d.height - ODSTEP;
    var poniżej = gora < MARGINES_EKRANU;
    var y = poniżej ? r.bottom + ODSTEP : gora;

    var x = r.left + r.width / 2 - d.width / 2;
    x = Math.max(MARGINES_EKRANU, Math.min(x, window.innerWidth - d.width - MARGINES_EKRANU));

    dymek.style.left = Math.round(x) + 'px';
    dymek.style.top = Math.round(y) + 'px';
    dymek.classList.toggle('table-tooltip--below', poniżej);

    // Strzałka wskazuje środek elementu, nawet gdy dymek dosunął się do krawędzi
    var strzalkaX = r.left + r.width / 2 - x;
    dymek.style.setProperty('--tt-arrow-x', Math.round(strzalkaX) + 'px');
  }

  function pokaz(cel) {
    var tekst = cel.getAttribute('data-tooltip');
    if (!tekst) return;

    aktywny = cel;
    utworz();
    dymek.textContent = tekst;
    dymek.classList.add('is-visible');
    // Pozycja liczona PO wstawieniu tekstu — wcześniej nie znamy wymiarów
    pozycjonuj(cel);
  }

  function ukryj() {
    aktywny = null;
    if (dymek) dymek.classList.remove('is-visible');
  }

  function znajdzCel(el) {
    if (!el || !el.closest) return null;
    var cel = el.closest('.has-tooltip[data-tooltip]');
    return cel && cel.closest('.order-table') ? cel : null;
  }

  document.addEventListener('mouseover', function (e) {
    var cel = znajdzCel(e.target);
    if (cel && cel !== aktywny) pokaz(cel);
  });

  document.addEventListener('mouseout', function (e) {
    if (!aktywny) return;
    var doElementu = e.relatedTarget;
    if (doElementu && aktywny.contains(doElementu)) return;
    ukryj();
  });

  // Klawiatura: ten sam dymek na focusie, żeby podpowiedź nie była wyłącznie myszkowa
  document.addEventListener('focusin', function (e) {
    var cel = znajdzCel(e.target);
    if (cel) pokaz(cel);
  });
  document.addEventListener('focusout', ukryj);

  // Przewinięcie tabeli albo okna przesuwa element — dymek musi za nim nadążyć
  // albo zniknąć; przeliczamy, bo `fixed` nie jedzie razem z treścią.
  window.addEventListener('scroll', function () { if (aktywny) pozycjonuj(aktywny); }, true);
  window.addEventListener('resize', function () { if (aktywny) pozycjonuj(aktywny); });
})();
