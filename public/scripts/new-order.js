import { openAddAddressModal, sendAddressData } from './createNewAddress.js';
import { get, del } from './components/api_connector.js';
import { createInfoIcon } from './components/info.js';
const i18n = (key) => (typeof t === 'function' ? t(key) : key);



function toggleBtns(select, btnIds) {
    const edit = document.getElementById('update-order');
    if (edit) {
        btnIds.forEach(btnId => {

            const btn = document.getElementById(btnId);
            console.log(btn, select, select.value)

            if (select.value) {
                btn.classList.remove('d-none');
            } else {
                btn.classList.add('d-none');
            }
        });
    }

    select.addEventListener('change', () => {
        btnIds.forEach(btnId => {

            const btn = document.getElementById(btnId);
            console.log(btn, select, select.value)

            if (select.value) {
                btn.classList.remove('d-none');
            } else {
                btn.classList.add('d-none');
            }
        });
    });
}

async function openEditAddressModal() {
    const addrId = document.getElementById('address-select').value;
    if (!addrId) return;
    const url = `/address/${addrId}`;
    await get(url).then(addressResponse => {
        const currentAddress = addressResponse.addressData;

        const fields = [
            ["name", i18n('order.address_name')],
            ["phone", i18n('new-order.phone')],
            ["street", i18n('new-order.street')],
            ["city", i18n('new-order.city')],
            ["zip", i18n('new-order.zip')],
            ["country", i18n('new-order.country')],
            ["is_default", i18n('order.address_default_label'), { type: "checkbox" }]];

        openAddAddressModal(fields, `/address/${addrId}`, {
            title: i18n('order.edit_address'),
            requestMethod: "PUT",
            initialData: currentAddress,
            onSubmit: (_response, payload) => {
                const addressSelect = document.getElementById('address-select');
                const selectedOption = addressSelect.options[addressSelect.selectedIndex];
                if (selectedOption) {
                    selectedOption.textContent = formatAddressOption(payload);
                }
            }
        });
    })
}

async function openEditMailModal() {
    const mailSelect = document.getElementById('mail-select');
    const mailId = mailSelect?.value;
    if (!mailId) return;

    const mailResponse = await get(`/address/mail/${mailId}`);
    const fields = [["mail", i18n('new-order.email')]];

    openAddAddressModal(fields, `/address/mail/${mailId}`, {
        title: i18n('order.edit_mail'),
        requestMethod: "PUT",
        initialData: { mail: mailResponse.mail?.email || '' },
        onSubmit: (_response, payload) => {
            const selectedOption = mailSelect.options[mailSelect.selectedIndex];
            if (selectedOption) {
                selectedOption.textContent = payload.mail;
            }
        }
    });
}

async function deleteSelectedAddress() {
    const addressSelect = document.getElementById('address-select');
    const addrId = addressSelect?.value;
    if (!addrId) return;

    const shouldDelete = window.confirm(i18n('order.delete_address_dialog_info'));
    if (!shouldDelete) return;

    await del(`/address/${addrId}`);
    removeSelectedOption(addressSelect);
}

async function deleteSelectedMail() {
    const mailSelect = document.getElementById('mail-select');
    const mailId = mailSelect?.value;
    if (!mailId) return;

    const shouldDelete = window.confirm(i18n('order.delete_mail_dialog_info'));
    if (!shouldDelete) return;

    await del(`/address/mail/${mailId}`);
    removeSelectedOption(mailSelect);
}

function removeSelectedOption(select) {
    if (!select) return;

    const selectedValue = select.value;
    if (!selectedValue) return;

    const optionToRemove = select.querySelector(`option[value="${selectedValue}"]`);
    if (optionToRemove) {
        optionToRemove.remove();
    }

    select.value = "";
    select.dispatchEvent(new Event('change'));
}

function formatAddressOption(payload) {
    return `${payload.name || ''}  (${payload.street || ''} ${payload.city || ''} ${payload.zip || ''} ${payload.country || ''})`.trim();
}




const editAddressBtn = document.getElementById('edit-delivery-address-btn');
if (editAddressBtn) {
    editAddressBtn.addEventListener('click', openEditAddressModal);
}

const deleteAddressBtn = document.getElementById('delete-delivery-address-btn');
if (deleteAddressBtn) {
    deleteAddressBtn.addEventListener('click', deleteSelectedAddress);
}

const editMailBtn = document.getElementById('edit-mail-btn');
if (editMailBtn) {
    editMailBtn.addEventListener('click', openEditMailModal);
}

const deleteMailBtn = document.getElementById('delete-mail-btn');
if (deleteMailBtn) {
    deleteMailBtn.addEventListener('click', deleteSelectedMail);
}

document.addEventListener('DOMContentLoaded', () => {
    const addressSelect = document.getElementById('address-select');
    toggleBtns(addressSelect, ['edit-delivery-address-btn', 'delete-delivery-address-btn']);
    const mailSelect = document.getElementById('mail-select');
    toggleBtns(mailSelect, ['edit-mail-btn', 'delete-mail-btn']);

    const addressLabel = document.getElementById('address-checkbox-container');
    if (addressLabel) {
        createInfoIcon({
            info: t('new_order.address_info'),
            parent: addressLabel,
            defaultLabel: t('new_order.address_info')
        });
    }
    const differentAddressInfo = document.getElementById('send-address-checkbox-container');
    if (differentAddressInfo) {
        createInfoIcon({
            info: t('new_order.different_address_info'),
            parent: differentAddressInfo,
            defaultLabel: t('new_order.different_address_info')
        });
    }
});

// countrySelect init — locale from <html lang>
(function () {
    const langToCountry = { pl: 'pl', de: 'de', en: 'gb', nl: 'nl', fr: 'fr' };
    const currentCountry = langToCountry[document.documentElement.lang] || 'pl';
    const preferredList = [currentCountry].concat(['pl', 'de', 'gb', 'nl', 'fr'].filter(function (c) { return c !== currentCountry; }));
    $(function () {
        if ($.fn.countrySelect) {
            $('#country').countrySelect({ preferredCountries: preferredList, defaultCountry: currentCountry });
            $('#sendCountry').countrySelect({ preferredCountries: preferredList, defaultCountry: currentCountry });
        }
    });
}());

