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
    let infoIcon;
    const iconLabel = cleanInfoText || defaultLabel;
    if (infoStyle == 'i') {
        infoIcon = createElement("span", {
            class: className ? ["param-info-icon", className] : ["param-info-icon"],
            text: "i",
            tabindex: "0",
            "aria-label": iconLabel
        }, parent);
    } else if (infoStyle == 'btn-cupon') {
        infoIcon = createElement("span", {
            class: className ? ["param-info-cupon", className] : ["param-info-cupon"],
            text: cleanInfoText,
            tabindex: "0",
            "aria-label": iconLabel
        }, parent);
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

    if (extractedFilePath) {
        const normalizedFilePath = extractedFilePath.replace(/^\/+/, "");
        const encodedFilePath = normalizedFilePath.split("/").map(segment => encodeURIComponent(segment)).join("/");
        const fileUrl = `${rootFilePath}${encodedFilePath}`;
        const fileName = normalizedFilePath.split("/").pop() || "plik";

        createElement("button", {
            class: ["param-info-download-btn"],
            type: "button",
            html: `<span class="download-icon" aria-hidden="true">⬇</span><span>${fileName}</span>`,
            "aria-label": `${downloadLabel} ${fileName}`,
            onclick: async function (event) {
                event.preventDefault();
                event.stopPropagation();
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
        }, tooltip);
    }

    return infoIcon;
}
/**
 * INFO przypisane do KONKRETNEJ WARTOSCI slownika (kolumna <PARAM>_INFO
 * w paramdict), a nie do parametru - ta sama ikonka "i" z krotkim opisem
 * i przyciskiem pobrania pliku z zapisu <nazwa.rozszerzenie>.
 *
 * Slot jest czyszczony przy kazdym wywolaniu, bo wartosc pola zmienia sie
 * w trakcie wypelniania formularza, a ikonka ma opisywac wartosc AKTUALNA.
 * Pusty slot zostaje w DOM - ma zerowa szerokosc i nie rusza layoutu etykiety.
 */
export function renderValueInfoIcon(slot, info) {
    if (!slot) return null;
    slot.innerHTML = "";
    return createInfoIcon({
        info,
        parent: slot,
        defaultLabel: t("Dodatkowe informacje"),
        infoStyle: "i",
        downloadLabel: t("Pobierz"),
        className: "value-info-icon"
    });
}
