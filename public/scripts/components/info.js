import { createElement } from "./htmlManipulator.js";
import { showToast } from "./toast.js";

/**
 * Adres, pod ktorym przegladarka pobiera zalaczniki INFO - pliki z zapisu
 * `Opis <karta.pdf>` w `param.INFO` i w kolumnie `<PARAM>_INFO` w paramdict.
 *
 * JEDYNE miejsce z tym adresem po stronie klienta. Odpowiada mu na dysku
 * `config.infoFilesDir` (= `<photoPath>/files`), bo `/photos` jest zamontowane
 * na `photoPath` w server.js - te dwie rzeczy trzeba zmieniac razem, inaczej
 * kazdy zalacznik zwraca 404. Katalog zakladany jest przy starcie serwera.
 */
export const INFO_FILES_URL = "/photos/files/";

/**
 * Adres zalacznikow INFO **wartosci** (kolumna `<PARAM>_INFO` w paramdict).
 * W odroznieniu od INFO parametru pliki sa PER GRUPA - ta sama konwencja co
 * zdjecia wartosci (`/photos/<grupa>/<PARAM>/<plik>`), bo karta techniczna
 * tkaniny czy modelu nalezy do asortymentu, nie do calej instalacji.
 *
 * Na dysku odpowiada temu `<photoPath>/<grupa>/files` - katalog zakladany
 * leniwie przez serwer przy wejsciu w grupe (routes/positions.js,
 * `/position/version/:groupNr/` → utils/ensureInfoFilesDir.js).
 */
export function valueInfoFilesUrl(groupNumber) {
    const group = String(groupNumber ?? window.tempGroupNumber ?? "").trim();
    if (!/^\d{1,6}$/.test(group)) {
        // Bez numeru grupy nie da sie zlozyc adresu. Nie zgadujemy - globalny
        // katalog trzyma zalaczniki PARAMETROW i wskazanie go tutaj dawaloby
        // ciche 404 zamiast czytelnego sladu.
        console.warn("valueInfoFilesUrl: brak numeru grupy, pomijam adres zalacznika", groupNumber);
        return null;
    }
    return `/photos/${group}/files/`;
}

export function createInfoIcon({
    info,
    parent,
    rootFilePath = INFO_FILES_URL,
    defaultLabel = "Dodatkowe informacje",
    infoStyle = 'i',
    downloadLabel = "Pobierz",
    className = null,
} = {}) {
    const hasInfo = info && info !== "<NULL>" && `${info}`.trim() !== "";
    if (!hasInfo || !parent) {
        return null;
    }

    const rawInfo = `${info}`;
    const bracketMatch = rawInfo.match(/<([^>]+\.[^>]+)>/);
    const extractedFilePath = bracketMatch ? bracketMatch[1].trim() : null;

    const cleanInfoText = rawInfo.replace(/<[^>]+>/g, "").trim();

    // Adres zalacznika liczymy PRZED ikonka, bo klikniecie w samo "i" ma go od
    // razu pobrac - handler ikonki musi znac url i nazwe pliku.
    const normalizedFilePath = extractedFilePath ? extractedFilePath.replace(/^\/+/, "") : null;
    const hasAttachment = Boolean(normalizedFilePath && rootFilePath);
    const encodedFilePath = normalizedFilePath
        ? normalizedFilePath.split("/").map(segment => encodeURIComponent(segment)).join("/")
        : null;
    const fileUrl = hasAttachment ? `${rootFilePath}${encodedFilePath}` : null;
    const fileName = normalizedFilePath ? (normalizedFilePath.split("/").pop() || "plik") : null;

    async function downloadAttachment(event) {
        if (event) {
            event.preventDefault();
            // Ikonka siedzi w kafelku dialogu, ktory na klik wybiera wartosc i
            // zamyka okno - bez tego pobranie ginie razem z dialogiem.
            event.stopPropagation();
        }
        if (!fileUrl) {
            return;
        }
        try {
            const response = await fetch(fileUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const anchor = createElement("a", {
                href: blobUrl,
                download: fileName
            });
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(blobUrl);
        } catch (error) {
            showToast("error", `Nie udało się pobrać pliku: ${fileName}`);
        }
    }

    let infoIcon;
    const iconLabel = cleanInfoText || defaultLabel;
    // Klik w ikonke: z zalacznikiem pobiera plik, bez zalacznika tylko blokuje
    // propagacje (inaczej kafelek zostaje wybrany i dialog sie zamyka).
    const iconClickHandler = (event) => {
        // Dymek jest dzieckiem ikonki, wiec klik w jego tresc tu dolatuje -
        // nie traktujemy go jak klikniecia w ikonke (byloby drugie pobranie).
        if (event.target.closest && event.target.closest(".param-info-tooltip")) {
            event.stopPropagation();
            return;
        }
        if (hasAttachment) {
            downloadAttachment(event);
            return;
        }
        event.stopPropagation();
    };
    const attachmentClasses = hasAttachment ? ["has-attachment"] : [];
    const iconAria = hasAttachment ? `${iconLabel} - ${downloadLabel}: ${fileName}` : iconLabel;

    if (infoStyle == 'i') {
        infoIcon = createElement("span", {
            class: ["param-info-icon", ...attachmentClasses, ...(className ? [className] : [])],
            text: "i",
            tabindex: "0",
            "aria-label": iconAria,
            onclick: iconClickHandler
        }, parent);
    } else if (infoStyle == 'btn-cupon') {
        infoIcon = createElement("span", {
            class: ["param-info-cupon", ...attachmentClasses, ...(className ? [className] : [])],
            text: cleanInfoText,
            tabindex: "0",
            "aria-label": iconAria,
            onclick: iconClickHandler
        }, parent);
    }

    // Klawiatura: ikonka ma tabindex, wiec Enter/Spacja tez musza pobrac plik.
    if (infoIcon && hasAttachment) {
        infoIcon.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                downloadAttachment(event);
            }
        });
    }

    const tooltip = createElement("div", {
        class: ["param-info-tooltip"],
        role: "tooltip"
    }, infoIcon);

    if (cleanInfoText) {
        const normalizedInfoText = cleanInfoText.replace(/\\n/g, "\n").replace(/\n/g, "<br>");
        createElement("div", {
            class: ["param-info-tooltip-text"],
            html: normalizedInfoText
        }, tooltip);
    }

    // Przycisk w dymku zostaje jako czytelna nazwa pliku - klik w niego i klik
    // w sama ikonke robia dokladnie to samo.
    if (hasAttachment) {
        createElement("button", {
            class: ["param-info-download-btn"],
            type: "button",
            html: `<span class="download-icon" aria-hidden="true">⬇</span><span>${fileName}</span>`,
            "aria-label": `${downloadLabel} ${fileName}`,
            onclick: downloadAttachment
        }, tooltip);
    }

    return infoIcon;
}
