

import { showToast } from "./toast.js";

const EYE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/></svg>';


export function createElement(tag, attributes = {}, parent = null) {
    const element = document.createElement(tag);
    const changedElem = manipulateElem(element, attributes, parent)
    return changedElem;
}
export function editElementById(tag, attributes = {}, parent = null) {
    const element = document.getElementById(tag)
    const changedElem = manipulateElem(element, attributes, parent)
    return changedElem;
}

function manipulateElem(element, attributes = {}, parent = null) {
    for (const [key, value] of Object.entries(attributes)) {
        if (key === 'text') {
            element.textContent = value;
        }
        else if (key === 'html') {
            element.innerHTML = value;
        }
        else if (key === 'class') {
            for (const className of value) {
                element.classList.add(className);
            }
        }
        else if (key === 'style') {
            if (typeof value === 'string') {
                element.style.cssText = value;
            }
            else if (typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(element.style, value);
            } else {
                console.warn('Niepoprawny typ atrybutu "style". Powinien być string lub obiekt, nie tablica.');
            }
        }
        else if (key === 'type') {
            element.type = value;
        }
        else if (key === 'value') {
            element.value = value;
        }
        else if (key === 'dataset') {
            for (const [dataKey, dataValue] of Object.entries(value)) {
                element.dataset[dataKey] = dataValue;
            }
        }
        else if (key.startsWith('on')) {
            const eventType = key.slice(2).toLowerCase();
            element.addEventListener(eventType, value);
        }
        else if (key === 'checked') {
            element.checked = value;
        }
        else if (key === 'disabled') {
            element.disabled = value;
        }
        else if (key === 'placeholder') {
            element.placeholder = value;
        }
        else if (key === 'src') {
            element.src = value;
        }
        else if (key === 'href') {
            element.href = value;  
        }
        else {
            element.setAttribute(key, value);
        }
    }
    if (parent) {
        parent.appendChild(element);
    }
    return element;
};


export function createInfoDialog({
    title = "",
    message = "",
    buttons = [
        { label: "OK", action: () => { }, className: "btn btn-secondary", id: "ok-btn", enter: false }
    ],
    parent = null,
    input = null,
    checkbox = null,
    // Klasa na samym <dialog> — pozwala zwężyć/przestylować KONKRETNY monit
    // (np. `compact-dialog` przy kłódce rabatu) bez ruszania szerokich dialogów
    // potwierdzeń, które dzielą ten sam element `#delete-dialog`.
    className = ""
} = {}) {
    if (!parent) throw new Error("Parent element is required!");

    
    const existingDialog = document.getElementById("delete-dialog");
    if (existingDialog) {
        existingDialog.remove();
    }

    const dialogAttrs = { id: "delete-dialog" };
    if (className) dialogAttrs.class = className.split(" ").filter(Boolean);
    const dialog = createElement("dialog", dialogAttrs, parent);

    if (title) {
        createElement("h3", { class: ["text-center"], id: "dialog-title", text: title }, dialog);
    }

    if (input) {
        const inputDiv = createElement('div', { id: 'diag-input-container', class: ['diag-input-container'] }, dialog)
        createElement('label', { for: input.id, class: ['dialog-label', 'mb-1'], text: input.name }, inputDiv)
        if (input.type === 'password') {
            // Hasło z okiem „pokaż/ukryj” w polu (kłódki cen w order.js i każdy
            // inny monit o hasło). Styl: `.dialog-password-*` w dialog.css.
            const wrap = createElement('div', { class: ['dialog-password-wrap'] }, inputDiv)
            const field = createElement('input', { type: 'password', class: ['dialog-inputs'], id: input.id }, wrap)
            const toggleLabel = window.t?.('group.sf_password_toggle') || 'Pokaż/ukryj hasło'
            const toggle = createElement('button', {
                type: 'button',
                class: ['dialog-password-toggle'],
                title: toggleLabel,
                'aria-label': toggleLabel,
                'aria-controls': input.id,
                'aria-pressed': 'false',
                html: EYE_ICON
            }, wrap)
            toggle.addEventListener('click', () => {
                const show = field.type === 'password'
                field.type = show ? 'text' : 'password'
                toggle.setAttribute('aria-pressed', String(show))
                toggle.innerHTML = show ? EYE_OFF_ICON : EYE_ICON
                field.focus()
                field.setSelectionRange(field.value.length, field.value.length)
            })
        } else {
            createElement('input', { type: input.type, class: ['dialog-inputs'], id: input.id }, inputDiv)
        }
    }
    if (checkbox) {
        // ⚠️ `for` MUSI wskazywać na `checkbox.id` (nie stały `dialog-checkbox`,
        // jak było wcześniej) — inaczej klik w SAM TEKST etykiety (naturalny
        // odruch) nic nie robi, bo `for` nie trafia w żaden istniejący `id`.
        // Kwadracik działał, ale użytkownik klikający napis myślał, że
        // zaznaczył checkbox, a on zostawał odznaczony.
        const checkboxDiv = createElement('div', { id: 'diag-checkbox-container', class: ['mt-4', 'ms-3'] }, dialog)
        createElement('input', { type: 'checkbox', class: ['dialog-checkbox', 'form-check-input', 'p-1'], id: checkbox.id }, checkboxDiv)
        createElement('label', { for: checkbox.id, class: ['dialog-checbox-label', 'mb-1', 'ms-2'], text: checkbox.name }, checkboxDiv)
    }
    createElement("p", { class: ["text-center"], html: message }, dialog);

    createElement("div", { class: ["alert"], id: "status-info" }, dialog);

    const btnContainer = createElement("div", { class: ["confirmattion-buttons"] }, dialog);

    const buttonElements = [];
    buttons.forEach(({ label, action, className = "", id = "", enter = false }) => {
        const btn = createElement("button", {
            text: label,
            class: className.split(" ").filter(Boolean),
            id: id,
            type: "button",
            onclick: (e) => {
                e.preventDefault();
                if (typeof action === "function") {
                    action();
                }
                
                dialog.close();
                dialog.remove();
            }
        }, btnContainer);
        btn.dataset.enter = enter ? "true" : "false";
        buttonElements.push(btn);
    });

    
    const enterButton = buttonElements.find(btn => btn.dataset.enter === "true");
    if (enterButton) {
        dialog.addEventListener("keydown", (e) => {
            // Enter na oku przełącza widoczność hasła, a nie zatwierdza okna.
            if (e.key === "Enter" && !e.target.closest(".dialog-password-toggle")) {
                e.preventDefault();
                enterButton.click();
            }
        });
    }

    if (typeof dialog.showModal === "function") {
        console.log("Opening delete dialog - showModal supported");
        dialog.showModal();

        
        setTimeout(() => {
            dialog.style.display = 'grid';
            dialog.style.visibility = 'visible';
            dialog.style.opacity = '1';
            console.log("Dialog forced visible for iOS");
        }, 50);
    } else {
        console.log("showModal not supported - using fallback");
        
        dialog.style.display = 'grid';
        dialog.style.visibility = 'visible';
        dialog.style.opacity = '1';
        dialog.style.position = 'fixed';
        dialog.style.zIndex = '99999';
        dialog.setAttribute('open', '');
    }

    return { buttons: buttonElements, diag: dialog };
}

export function isEnabled(formula, values, paramName) {

    let isEnabled = false;
    try {
        isEnabled = window.FormulaHandler.evaluateFormula(
            formula,
            values,
            "paramdict",
            paramName
        );
        if (isEnabled == 'password') { isEnabled = false }
    }
    catch (error) {

        console.log('mamy error')

        showToast('error', `Error:  ${error.message}`)
    }
    return isEnabled;
}

