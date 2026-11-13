import { createElement } from "./components/htmlManipulator.js";

const MODAL_ID = "add-address-modal";
const i18n = (key) => (typeof t === 'function' ? t(key) : key);

document.addEventListener("DOMContentLoaded", () => {
    const addDeliveryAddressBtn = document.getElementById("add-delivery-address-btn");
    const addMailBtn = document.getElementById("add-mail-btn");

    if (addDeliveryAddressBtn) {
        addDeliveryAddressBtn.addEventListener("click", (event) => {
            event.preventDefault();
            openAddAddressModal([
                ["name", i18n('order.address_name')],
                ["phone", i18n('new-order.phone')],
                ["street", i18n('new-order.street')],
                ["city", i18n('new-order.city')],
                ["zip", i18n('new-order.zip')],
                ["country", i18n('new-order.country')],
                ["is_default", i18n('order.address_default_label'), { type: "checkbox" }]
            ], '/address/add-delivery-address', {
                title: i18n('order.create_address'),
                onSubmit: async (response) => {
                    await refreshSelectList('address-select', '/address/list', response?.data?.id, 'address');
                }
            });
        });
    }

    if (addMailBtn) {
        addMailBtn.addEventListener("click", (event) => {
            event.preventDefault();
            openAddAddressModal([["mail", i18n('new-order.email')]], '/address/add-mail-address', {
                title: i18n('order.create_mail'),
                onSubmit: async (response) => {
                    await refreshSelectList('mail-select', '/address/mail-list', response?.data?.id, 'mail');
                }
            });
        });
    }
});

function openAddAddressModal(inputsList = [], url, options = {}) {
    if (!Array.isArray(inputsList) || inputsList.length === 0) {
        throw new Error("inputsList musi być niepustą tablicą tupli [id, text].");
    }

    const existingModal = document.getElementById(MODAL_ID);
    if (existingModal) {
        existingModal.remove();
    }

    const preparedInputs = inputsList.map(normalizeInputConfig);
    const initialData = options.initialData || options.addressData || {};

    const dialog = createElement("dialog", {
        id: MODAL_ID,
        class: ["rounded-3", "border-0", "p-0"]
    }, document.body);

    const form = createElement("form", {
        method: "dialog",
        class: ["p-4", "d-flex", "flex-column", "gap-3"]
    }, dialog);

    createElement("h5", {
        text: options.title || i18n('order.create_address'),
        class: ["mb-1"]
    }, form);

    const fieldsContainer = createElement("div", {
        class: ["d-flex", "flex-column", "gap-2"]
    }, form);

    preparedInputs.forEach((inputConfig) => {
        const wrapper = createElement("div", { class: ["mb-1"] }, fieldsContainer);

        createElement("label", {
            for: inputConfig.id,
            text: inputConfig.label,
            class: ["form-label", "mb-1"]
        }, wrapper);

        if (inputConfig.name === "country") {
            const countryInput = createElement("input", {
                type: "text",
                id: inputConfig.id,
                name: inputConfig.name,
                placeholder: inputConfig.placeholder,
                class: ["form-control"]
            }, wrapper);

            inputConfig._isCountrySelect = true;
        } else if (inputConfig.type === "checkbox") {
            createElement("input", {
                type: "checkbox",
                id: inputConfig.id,
                name: inputConfig.name,
                class: ["form-check-input", "ms-2"]
            }, wrapper).checked = !!Number(initialData[inputConfig.name]);
        } else {
            const inputElement = createElement("input", {
                type: inputConfig.type,
                id: inputConfig.id,
                name: inputConfig.name,
                placeholder: inputConfig.placeholder,
                value: initialData[inputConfig.name] ?? inputConfig.value,
                class: ["form-control"]
            }, wrapper);

            if (inputConfig.required) {
                inputElement.required = true;
            }
        }
    });

    const actions = createElement("div", {
        class: ["d-flex", "justify-content-end", "gap-2", "pt-2"]
    }, form);

    createElement("button", {
        type: "button",
        text: options.cancelLabel || i18n('form.cancel_button'),
        class: ["btn", "btn-outline-secondary"],
        onclick: () => {
            dialog.close("cancel");
            dialog.remove();
            if (typeof options.onCancel === "function") {
                options.onCancel();
            }
        }
    }, actions);

    createElement("button", {
        type: "button",
        text: options.submitLabel || i18n('new-order.save_button'),
        class: ["btn", "btn-success"],
        onclick: async () => {
            const payload = {};

            for (const inputConfig of preparedInputs) {
                if (inputConfig._isCountrySelect) {
                    const codeInput = document.getElementById(inputConfig.id + "_code");
                    payload[inputConfig.name] = codeInput ? codeInput.value.trim() : "";
                    continue;
                }

                const inputElement = document.getElementById(inputConfig.id);
                if (!inputElement) {
                    continue;
                }
                if (inputElement.type === "checkbox") {
                    payload[inputConfig.name] = inputElement.checked;
                    continue;
                }

                const value = inputElement.value.trim();

                if (inputConfig.required && !value) {
                    inputElement.focus();
                    inputElement.reportValidity();
                    return;
                }

                if (value && !inputElement.checkValidity()) {
                    inputElement.focus();
                    inputElement.reportValidity();
                    return;
                }

                payload[inputConfig.name] = value;
            }

            try {
                const response = await sendAddressData(url, payload, options.requestMethod || "POST");
                if (typeof options.onSubmit === "function") {
                    options.onSubmit(response, payload);
                }
                dialog.close("submit");
                dialog.remove();
            } catch (error) {
                console.error("Błąd podczas zapisu adresu:", error);
            }
        }
    }, actions);

    dialog.addEventListener("close", () => {
        if (dialog.isConnected) {
            dialog.remove();
        }
    });

    if (typeof dialog.showModal === "function") {
        dialog.showModal();
    } else {
        dialog.setAttribute("open", "");
    }

    // Initialize countrySelect on country fields after dialog is in the DOM
    preparedInputs.forEach((inputConfig) => {
        if (inputConfig._isCountrySelect && typeof $ !== "undefined" && $.fn.countrySelect) {
            const $el = $(`#${inputConfig.id}`);
            const initCountry = initialData[inputConfig.name] || "pl";
            $el.countrySelect({
                preferredCountries: ["pl", "de", "gb", "nl", "fr"],
                defaultCountry: initCountry.length === 2 ? initCountry.toLowerCase() : "pl"
            });
        }
    });

    return dialog;
}

function normalizeInputConfig(input) {
    if (Array.isArray(input) && input.length >= 2) {
        const rawName = String(input[0] ?? "").trim();
        const label = String(input[1] ?? "").trim();

        if (!rawName) {
            throw new Error("Tuple inputu musi zawierać poprawne id.");
        }

        if (!label) {
            throw new Error(`Tuple '${rawName}' musi zawierać text etykiety.`);
        }

        const extraConfig = input[2] && typeof input[2] === "object" ? input[2] : {};

        const isEmailField = ["mail", "email"].includes(rawName.toLowerCase());

        return {
            name: rawName,
            id: `${toSafeId(rawName)}-input`,
            label,
            type: extraConfig.type || (isEmailField ? "email" : "text"),
            placeholder: extraConfig.placeholder || (isEmailField ? "nazwa@domena.pl" : ""),
            required: Boolean(extraConfig.required),
            value: extraConfig.value || ""
        };
    }

    throw new Error("Każdy element inputsList musi być tuplem [id, text].");
}

function toSafeId(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Generyczna funkcja do odświeżania listy w select (adresy dostawy lub emaile)
 * @param {string} selectId - ID elementu select do odświeżenia
 * @param {string} apiUrl - URL do pobrania danych (np. '/address/list' lub '/address/mail-list')
 * @param {number|string} selectedId - ID elementu do wybrania po odświeżeniu (opcjonalne)
 * @param {string} type - Typ danych: 'address' lub 'mail'
 */
async function refreshSelectList(selectId, apiUrl, selectedId = null, type = 'address') {
    const select = document.getElementById(selectId);
    if (!select) {
        return;
    }

    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Błąd podczas odświeżania listy: ${response.statusText}`);
        }

        const result = await response.json();

        // Obsługi różne struktury odpowiedzi w zależności od typu
        let items = [];
        if (type === 'mail') {
            items = Array.isArray(result.emails) ? result.emails : [];
        } else {
            items = Array.isArray(result.addresses) ? result.addresses :
                Array.isArray(result) ? result : [];
        }

        select.innerHTML = '';

        // Utwórz placeholder
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = type === 'mail'
            ? i18n('order.select_email_address')
            : i18n('new-order.select_address');
        placeholderOption.disabled = true;
        select.appendChild(placeholderOption);

        // Dodaj opcje
        items.forEach((item) => {
            const option = document.createElement('option');
            option.value = String(item.id);

            if (type === 'mail') {
                option.textContent = item.email;
            } else {
                option.textContent = `${item.name}  (${item.street} ${item.city} ${item.zip} ${item.country})`;
            }

            if (selectedId && String(item.id) === String(selectedId)) {
                option.selected = true;
            }

            select.appendChild(option);
        });

        if (!selectedId) {
            placeholderOption.selected = true;
        }

        select.dispatchEvent(new Event('change'));
    } catch (error) {
        console.error('Błąd podczas odświeżania listy:', error);
    }
}

// Zachowaj starą funkcję dla wstecznej zgodności
async function refreshUserAddressList(selectedAddressId = null) {
    return refreshSelectList('address-select', '/address/list', selectedAddressId, 'address');
}

async function sendAddressData(url, data, method = "POST") {
    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        throw new Error(`Błąd sieci: ${response.statusText}`);
    }
    return response.json();
}

export { openAddAddressModal, sendAddressData, refreshSelectList, refreshUserAddressList };