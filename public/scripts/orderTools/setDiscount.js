import { showToast } from "../components/toast.js";
import { createInfoDialog, createElement } from "../components/htmlManipulator.js";
import { currencySymbol, getPriceCurrency } from "../formTools/currencyLabel.js";

/**
 * Symbol waluty klienta zamówienia („€”, „zł”) — `window.priceCurrency` z
 * base.njk (services/currency.js). Rabat kwotowy jest w walucie zamówienia.
 */
const waluta = () => currencySymbol(getPriceCurrency());


const HKL_ORG_ID = 3;

function getOrderOrgId() {
    const el = document.getElementById('order-title') || document.getElementById('order-title-mobile');
    const orgId = el?.dataset.orgId;
    if (orgId == null || orgId === '') return HKL_ORG_ID;
    const parsed = parseInt(orgId, 10);
    return Number.isNaN(parsed) ? HKL_ORG_ID : parsed;
}

function parsePriceText(text) {
    const priceText = text.replace(/[^\d.,-]/g, '').replace(',', '.');
    const priceValue = parseFloat(priceText);
    return isNaN(priceValue) ? 0 : priceValue;
}

export function getTotal() {
    const orgId = getOrderOrgId();
    const totalContainer = document.getElementById('total-container');

    // Non-HKL: rabat liczony od sumy SUB___ (nie od zwykłych cen na stronie org)
    if (orgId !== HKL_ORG_ID && totalContainer?.dataset.subTotal != null) {
        const subTotal = parseFloat(totalContainer.dataset.subTotal);
        if (!Number.isNaN(subTotal) && subTotal !== 0) {
            return subTotal;
        }
    }

    const totalPrice = document.querySelector('.total');
    if (totalPrice) {
        return parsePriceText(totalPrice.textContent);
    }
    return 0;
}

export async function showDiscountModal() {
    let discountText = "0"
    const discountInfo = await fetchCurrentDiscount()
    if (discountInfo.type == 'percentage') {
        discountText = `${discountInfo.discountValue}%`;
    } else if (discountInfo.type == 'value') {
        discountText = `${discountInfo.discountValue} ${waluta()}`;
    }

    console.log(discountInfo, 'discountInfo w showDiscountModal #######################')
    const dialogContainer = document.getElementById('dialog-container');
    const discountDialogExisting = document.getElementById('discount-dialog');
    if (discountDialogExisting) {
        discountDialogExisting.remove();
    }

    const dialog = createElement('dialog', { id: 'discount-dialog', class: ['dialog', 'discount-dialog'] }, dialogContainer);
    const title = createElement('h2', { text: t('order.set_discount_for_order'), class: ['discount-dialog-title'] }, dialog);

    
    const currentValueContainer = createElement('div', { class: ['current-discount-container'] }, dialog);
    createElement('span', { text: t('order.order_value'), class: ['current-discount-label'] }, currentValueContainer);
    createElement('span', { text: ` ${getTotal()} ${waluta()}`, id: 'current-discount-value', class: ['current-discount-value'] },
        currentValueContainer);

    const currentDiscountContainer = createElement('div', { class: ['current-discount-container'] }, dialog);
    createElement('span', { text: t('order.current_discount'), class: ['current-discount-label'] }, currentDiscountContainer);
    createElement('span', { text: discountText, id: 'current-discount-value', class: ['current-discount-value'] }, currentDiscountContainer);

    
    const percentSection = createElement('div', { class: ['discount-section'] }, dialog);
    const percentCheckboxContainer = createElement('div', { class: ['discount-checkbox-container'] }, percentSection);
    const percentCheckbox = createElement('input', {
        type: 'checkbox',
        id: 'discount-percent-checkbox',
        class: ['discount-checkbox']
    }, percentCheckboxContainer);
    createElement('label', {
        for: 'discount-percent-checkbox',
        text: t('order.percent_discount') + ' (%)',
        class: ['discount-checkbox-label']
    }, percentCheckboxContainer);

    const percentInputContainer = createElement('div', { class: ['discount-input-container'] }, percentSection);
    const percentInput = createElement('input', {
        type: 'number',
        id: 'discount-percent-input',
        min: '0',
        max: '100',
        value: '0',
        disabled: true,
        class: ['discount-input'],
        placeholder: 'np. 15'
    }, percentInputContainer);
    createElement('span', { text: '%', class: ['discount-unit'] }, percentInputContainer);

    
    const percentCalculatedAmount = createElement('div', {
        class: ['discount-calculated-amount'],
        text: `${t('order.discount_amount')}: 0 ${waluta()}`,
        id: 'percent-calculated-amount',
        style: 'display: none;'
    }, percentSection);

    const percentFinalAmount = createElement('div', {
        class: ['discount-final-amount'],
        text: `${t('order.total_after_discount')}: ${getTotal().toFixed(2)} ${waluta()}`,
        id: 'percent-final-amount',
        style: 'display: none;'
    }, percentSection);

    
    percentInput.addEventListener('input', () => {
        let value = parseFloat(percentInput.value);
        if (value > 100) {
            percentInput.value = '100';
            value = 100;
        } else if (value < 0) {
            percentInput.value = '0';
            value = 0;
        }

        
        const totalValue = getTotal();
        const discountAmount = (totalValue * value) / 100;
        const finalAmount = totalValue - discountAmount;

        if (value > 0) {
            percentCalculatedAmount.style.display = 'block';
            percentFinalAmount.style.display = 'block';
            percentCalculatedAmount.textContent = `${t('order.discount_amount')}: ${discountAmount.toFixed(2)} ${waluta()}`;
            percentFinalAmount.textContent = `${t('order.total_after_discount')}: ${finalAmount.toFixed(2)} ${waluta()}`;
        } else {
            percentCalculatedAmount.style.display = 'none';
            percentFinalAmount.style.display = 'none';
        }
    });

    
    const amountSection = createElement('div', { class: ['discount-section'] }, dialog);
    const amountCheckboxContainer = createElement('div', { class: ['discount-checkbox-container'] }, amountSection);
    const amountCheckbox = createElement('input', {
        type: 'checkbox',
        id: 'discount-amount-checkbox',
        class: ['discount-checkbox']
    }, amountCheckboxContainer);
    createElement('label', {
        for: 'discount-amount-checkbox',
        text: `${t('order.amount_discount')} (${waluta()})`,
        class: ['discount-checkbox-label']
    }, amountCheckboxContainer);

    const amountInputContainer = createElement('div', { class: ['discount-input-container'] }, amountSection);
    const amountInput = createElement('input', {
        type: 'number',
        id: 'discount-amount-input',
        min: '0',
        value: '0',
        disabled: true,
        class: ['discount-input'],
        placeholder: 'np. 100'
    }, amountInputContainer);
    createElement('span', { text: waluta(), class: ['discount-unit'] }, amountInputContainer);

    


    
    const amountFinalAmount = createElement('div', {
        class: ['discount-final-amount'],
        text: `${t('order.total_after_discount')}: ${getTotal().toFixed(2)} ${waluta()}`,
        id: 'amount-final-amount',
        style: 'display: none;'
    }, amountSection);

    
    amountInput.addEventListener('input', () => {
        let value = parseFloat(amountInput.value);
        const totalValue = getTotal();

        if (value > totalValue) {
            amountInput.value = totalValue.toFixed(2);
            showToast('Rabat kwotowy nie może być większy niż wartość zamówienia.', 'warning');
            value = totalValue;
        } else if (value < 0) {
            amountInput.value = '0';
            value = 0;
        }

        
        const finalAmount = totalValue - value;

        if (value > 0) {
            amountFinalAmount.style.display = 'block';
            amountFinalAmount.textContent = `${t('order.total_after_discount')}: ${finalAmount.toFixed(2)} ${waluta()}`;
        } else {
            amountFinalAmount.style.display = 'none';
        }
    });

    
    percentCheckbox.addEventListener('change', () => {
        if (percentCheckbox.checked) {
            amountCheckbox.checked = false;
            percentInput.disabled = false;
            amountInput.disabled = true;
            amountInput.value = '0';

            amountFinalAmount.style.display = 'none';
        } else {
            percentInput.disabled = true;
            percentInput.value = '0';
            percentCalculatedAmount.style.display = 'none';
            percentFinalAmount.style.display = 'none';
        }
    });

    amountCheckbox.addEventListener('change', () => {
        if (amountCheckbox.checked) {
            percentCheckbox.checked = false;
            amountInput.disabled = false;
            percentInput.disabled = true;
            percentInput.value = '0';
            percentCalculatedAmount.style.display = 'none';
            percentFinalAmount.style.display = 'none';
        } else {
            amountInput.disabled = true;
            amountInput.value = '0';

            amountFinalAmount.style.display = 'none';
        }
    });

    const buttonContainer = createElement('div', { class: ['discount-button-container'] }, dialog);
    const applyButton = createElement('button', { class: ['btn', 'btn-success'], text: t('order.apply_discount') }, buttonContainer);
    const cancelButton = createElement('button', { class: ['btn', 'btn-secondary'], text: t('order.cancel') }, buttonContainer);

    applyButton.addEventListener('click', () => {
        if (percentCheckbox.checked) {
            const discountValue = parseFloat(percentInput.value);
            if (isNaN(discountValue) || discountValue < 0 || discountValue > 100) {
                showToast('Proszę wprowadzić prawidłową wartość rabatu między 0 a 100%.', 'error');
                return;
            }
            
            setDiscount(discountValue, 0);
            showToast(`Rabat ${discountValue}% został zastosowany do zamówienia.`, 'success');
        } else if (amountCheckbox.checked) {
            const discountAmount = parseFloat(amountInput.value);
            if (isNaN(discountAmount) || discountAmount < 0) {
                showToast('Proszę wprowadzić prawidłową kwotę rabatu.', 'error');
                return;
            }
            setDiscount(0, discountAmount);
            showToast(`Rabat ${discountAmount} ${waluta()} został zastosowany do zamówienia.`, 'success');
        } else {
            showToast('Proszę wybrać typ rabatu (procentowy lub kwotowy).', 'warning');
            return;
        }

        dialog.close();
        dialog.remove();
    });

    cancelButton.addEventListener('click', () => {
        dialog.close();
        dialog.remove();
    });

    if (typeof dialog.showModal === "function") {
        dialog.showModal();

        setTimeout(() => {
            dialog.style.display = 'grid';
            dialog.style.visibility = 'visible';
            dialog.style.opacity = '1';
        }, 50);
    } else {
        dialog.style.display = 'grid';
        dialog.style.visibility = 'visible';
        dialog.style.opacity = '1';
        dialog.style.position = 'fixed';
        dialog.style.zIndex = '99999';
        dialog.setAttribute('open', '');
    }

}

async function setDiscount(discountPercentage, discountValue) {
    try {
        const orderId = document.getElementById('order-title').dataset.id;

        const response = await fetch(`/orders/order/${orderId}/set-discount`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ discountPercentage, discountValue })
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const result = await response.json();
        console.log(result);
        updateDiscountDisplay()
        return result;
    } catch (error) {
        console.error('Error setting discount:', error);
        throw error;
    }
}

export async function fetchCurrentDiscount() {
    const orderId = document.getElementById('order-title').dataset.id;
    try {
        const response = await fetch(`/orders/order/${orderId}/discount-info`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.log(response)
            throw new Error('Network response was not ok');
        }

        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('Error fetching discount info:', error);
        throw error;
    }
}

export async function updateDiscountDisplay() {
    const totalContainer = document.getElementById('total-container');
    if (!totalContainer) {
        return;
    }

    if (totalContainer.dataset.pricesUnlocked === 'true') {
        const discontSpace = document.getElementById('discount-space');
        if (discontSpace) discontSpace.remove();
        return;
    }

    const discountInfo = await fetchCurrentDiscount()
    let type = '';
    if (discountInfo.type == 'percentage') {
        type = '%';
    }
    else if (discountInfo.type == 'value') {
        type = waluta()
    }
    else if (discountInfo.type == 'none') {
        const discontSpace = document.getElementById('discount-space');
        if (discontSpace) discontSpace.remove();
        return;
    }

    const discountAmount = parseFloat(discountInfo.discountValue);
    if (!Number.isFinite(discountAmount) || discountAmount <= 0) {
        const discontSpace = document.getElementById('discount-space');
        if (discontSpace) discontSpace.remove();
        return;
    }

    const discontSpace = document.getElementById('discount-space')
    if (discontSpace){
        discontSpace.remove();
    }
    
    const discountSpace = createElement('div', { id: 'discount-space', class: ['total-price', 'd-flex', 'justify-content-end', 'align-items-center'] }, totalContainer);
    const discountValueContainer = createElement('div', { id: 'discount-amount', class: ['total', 'price-label', 'col-3', 'text-center', 'fw-bold', 'bg-discount', 'text-white', 'justify-content-end'] }, discountSpace)
    const discountContainer = createElement('div', { id: 'discount-info', class: ['total', 'price-label', 'col-3', 'text-center', 'fw-bold', 'bg-discount', 'text-white', 'justify-content-end'] }, discountSpace)
    
    
    const discountAfterSpan = createElement('span', { text: t('order.discount') , class: ['discount-label'] }, discountValueContainer);
    const discount = createElement('span', { id: 'discount-value', text: ` ${discountInfo.discountValue} ${type}`, class: ['discount-value'] }, discountValueContainer);
    
    const discountSpan = createElement('span', { text: t('order.total_after_discount'), class: ['discount-label'] }, discountContainer);

    const discountValueSpan = createElement('span', { id: 'discount-value', text: ` ${discountInfo.result} ${waluta()}`, class: ['discount-value'] }, discountContainer);

}