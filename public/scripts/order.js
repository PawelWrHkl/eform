import { showToast } from "./components/toast.js";
import { createInfoDialog, createElement } from "./components/htmlManipulator.js";
import { generateExcel as generateExcelOld, generatePdf } from "./components/generators.js"
import { generateExcel } from "./components/generators_exceljs.js"
import { showDiscountModal, updateDiscountDisplay } from "./orderTools/setDiscount.js";


const closeBtn = document.getElementById('cancel-btn');
const confirmBtn = document.getElementById('confirm-btn');
const deletePositionBtns = document.querySelectorAll('.delete-position-btn');
const deleteOrderBtn = document.getElementById('delete-order-btn');
const confirmationDialog = document.getElementById('delete-dialog');
const statusInfo = document.getElementById('status-info');
const commentBtn = document.getElementById('comment-btn');
const editIcon = document.getElementById('edit-comment-btn');
const unlockBtns = document.querySelectorAll('[id="unlockBtn"]')
const unlockSubBtns = document.querySelectorAll('[id="unlockSubBtn"]')
const lockBtns = document.querySelectorAll('[id="lockBtn"]')
const sendBtn = document.querySelector('.send-order-btn')
const excelBtns = document.querySelectorAll('[id="generate-excel-btn"]')
const printBtns = document.querySelectorAll('[id="print-button"]')
const shortPrintBtns = document.querySelectorAll('[id="short-print-button"]')
const discountBtn = document.getElementById('discount-btn');
const moveUpBtns = document.querySelectorAll('.move-up-btn')
const moveDownBtns = document.querySelectorAll('.move-down-btn')
const productionOrderCheckbox = document.getElementById('production-order-checkbox');
const productionOrderWarning = document.getElementById('production-order-warning');
getPrices()

export async function deleteItem(path) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`${t('order.error_word')}: ${res.statusText}`);
  const data = await res.json();
  document.getElementById('for-sure').style.display = 'none';
  statusInfo.innerHTML = t(`${data.message}`) + `. ${t('order.redirecting_word')}`;
  statusInfo.classList.add(data.success ? 'alert-success' : 'alert-danger');
  if (data.success) {
    closeBtn.hidden = confirmBtn.hidden = true;
    setTimeout(() => {
      if (path.includes('position')) location.reload();
      else window.location.href = '/orders';
    }, 300);
  }
}

export function deleteDiag(btn) {
  btn.addEventListener('click', () => {
    confirmationDialog.showModal();
    closeBtn.onclick = () => confirmationDialog.close();
    confirmBtn.onclick = () => deleteItem(btn.dataset.href);
  });
}

deletePositionBtns.forEach(deleteDiag);
if (deleteOrderBtn) deleteDiag(deleteOrderBtn);

function editBtn() {
  window.location.href = `/edit-position.html?id=${positionId}`;
}


const duplicateBtns = document.querySelectorAll('.duplicate-btn')
duplicateBtns.forEach((btn) => {

  btn.addEventListener('click', async () => {
    
    await duplicate(btn)

  })
});


function createDuplicateDiag(btn) {
  const { buttons, diag } = createInfoDialog({
    title: t('position.duplicate_header'),
    message: t('position.duplicate_text'),
    parent: document.body,
    buttons: [
      {
        label: t('order.cancel'),
        className: "btn btn-secondary m-2",
        id: "cancel-btn"
      },
      {
        label: t('common.ok'),
        className: "btn btn-success m-2",
        id: "confirm-btn",
        action: async () => {
          await duplicate(btn)

        }
      }
    ]
  });
  const acceptBtn = buttons[1]
  acceptBtn.focus()

}

async function duplicate(btn) {
  try {
    const id = btn.dataset.id;
    const response = await fetch(`/position/${id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const result = await response.json();

    if (response.ok) {
      setTimeout(() => {
        window.location.href = result.redirect;
      }, 300);
    } else if (result.redirect) {
      window.location.href = result.redirect;
    } else {
      showToast('error', result.error || t('order.duplicate_error'));
    }
  } catch (error) {
    showToast('error', error.message || error);
  }
}


export function buildAndShowDialog(btn) {
  const parent = document.getElementById('dialog-container');
  const productionOrder = isProductionOrderSelected();
  const { buttons, dialog } = createInfoDialog({
    title: `${t('orders.send_order')}`,
    message: getSendDialogMessage(t('orders.are_you_sure'), productionOrder),
    buttons: [
      {
        label: `${t('orders.abort')}`,
        className: "btn btn-secondary me-1",
        id: "cancel-btn"
      },
      {
        label: `${t('orders.send_word')}`,
        action: () => sendOrder(btn, { productionOrder }),
        className: "btn btn-success ms-1",
        id: "confirm-btn"
      }
    ],
    parent
  });
}

function getPrices() {
  const prices = {
    hiddenPrices: [],
    visiblePrices: []
  };
  const hiddenPrice = document.querySelectorAll('.total-hidden');
  const visiblePrice = document.querySelectorAll('.total');



  hiddenPrice.forEach(price => {
    const priceText = price.innerText?.trim();
    if (priceText) {
      prices.hiddenPrices.push(priceText);
    }
  });

  visiblePrice.forEach(price => {
    const priceText = price.innerText?.trim();
    if (priceText) {
      prices.visiblePrices.push(priceText);
    }
  });

  return prices;
}

function isProductionOrderSelected() {
  return !!productionOrderCheckbox?.checked;
}

function getSendDialogMessage(baseMessage, productionOrder) {
  if (!productionOrder) {
    return baseMessage;
  }

  return `<strong>${t('order.production_order_warning')}</strong><br>${t('order.production_order_confirm')}`;
}

function syncProductionOrderWarning() {
  if (!productionOrderCheckbox || !productionOrderWarning) {
    return;
  }

  productionOrderWarning.classList.toggle('d-none', !productionOrderCheckbox.checked);
}


async function sendOrder(sendBtn, options = {}) {
  const orderId = sendBtn.dataset.id
  const prices = getPrices();
  try {
    const response = await fetch(`/orders/send/${orderId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: 'sent', prices: prices, productionOrder: options.productionOrder === true })
    });
    const result = await response.json();
    console.log(response)
    if (result.status === "success") {
      showToast('success', `${t('orders.send_success_label')}`);
      setTimeout(() => {
        window.location.href = result.redirect;
      }, 600);

    } else if (result.redirect) {
      window.location.href = result.redirect;
    } else {
      showToast('error', result.message);
    }
  }
  catch (error) {
    showToast('error', error);
  }
}

async function unlock(password) {
  try {
    const title = document.getElementById('order-title')
    const checkBoxRes = document.getElementById('checkbox-remember').checked
    const response = await fetch(`/user/auth/check-password`, {
      method: "POST",
      body: JSON.stringify({ password: password.value, remember: checkBoxRes, orderId: title.dataset.id }),
      headers: { "Content-Type": "application/json" }
    });

    const result = await response.json();

    if (result.success) {
      setTimeout(() => {
        window.location.reload();
      }, 300);
    } else {
      const diagInput = document.getElementById('diag-input-container')
      createElement('div', {
        class: ['alert', 'alert-danger', 'mt-3', 'me-4', 'p-2', 'text-center'], role: 'alert', text: t('order.invalid_password'),

      }, diagInput)
      console.log('HASLO NIEPRAWIDLOWE')
    }
  } catch (error) {
    console.log('error', error.message || error);
  }

}

async function lock() {
  try {
    console.log('lock lock lock')
    const response = await fetch(`/orders/lock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: false })
    });
    const result = await response.json();
    if (result.status == 'success') {
      window.location.reload(response.refresh)
    }
  }
  catch (err) {
    console.warn(err)
    window.location.href = '/'
  }
}

if (sendBtn) {
  sendBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    buildAndShowDialog(sendBtn)
  });
}

if (productionOrderCheckbox) {
  productionOrderCheckbox.addEventListener('change', syncProductionOrderWarning);
  syncProductionOrderWarning();
}

lockBtns.forEach(lockBtn => {
  lockBtn.addEventListener('click', async () => await lock())
})

excelBtns.forEach(btn => {
  btn.addEventListener('click', () => generateExcel())
})

printBtns.forEach(btn => {
  btn.addEventListener('click', () => generatePdf())
})

shortPrintBtns.forEach(btn => {
  btn.addEventListener('click', () => generatePdf(true))
})

document.querySelectorAll('.translate-pdf-lang').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const lang = e.currentTarget.dataset.lang;
    generatePdf(false, lang);
  });
})

window.addEventListener('scroll', function () {
  const navbar = document.getElementById('order-nav');
  const scrollTrigger = 120;

  if (window.scrollY > scrollTrigger) {
    navbar.classList.add('navbar-scrolled');
  } else {
    navbar.classList.remove('navbar-scrolled');
  }
});


unlockBtns.forEach(unlockBtn => {
  unlockBtn.addEventListener('click', function () {
    const parent = document.getElementById('dialog-container');

    const { buttons, diag } = createInfoDialog({
      title: `${t('order.unlock')}`,
      buttons: [
        {
          label: `${t('orders.abort')}`,
          className: "btn btn-secondary me-1",
          id: "cancel-btn"
        },
        {
          enter: true,
          label: `${t('order.unlock')}`,
          action: async () => await unlock(password),
          className: "btn btn-success ms-1",
          id: "confirm-btn"
        }
      ],
      parent,
      input: { name: `${t('login.password_label')}`, id: "password-input", type: 'password' },
      checkbox: { name: `${t('order.remember')}`, id: 'checkbox-remember' }
    });
    const password = document.getElementById('password-input')
  });
});

// --- Kłódka rabatu klienta grupy -------------------------------------------
// Grupa i klient końcowy (`group_user`) nie mają zwykłej kłódki cenowej — ta
// przechodzi przez `/user/auth/check-password`, które sprawdza hasło konta z
// sesji, a konto podrzędne dzieli sesję z grupą-matką i po prostu nie zna jej
// hasła. Dlatego rabat ma własną kłódkę: wiersze renderują się ukryte
// (`client-discount-row d-none`, templates/order.njk), a odsłonięcie wymaga
// PODANIA HASŁA TEGO KONTA (`/user/auth/check-login-password` — dla konta
// podrzędnego sprawdza `group_user.password`, dla pozostałych `user.password`).
// ⚠️ Schowanie z powrotem hasła nie wymaga, a poprawne hasło obowiązuje tylko do
// przeładowania strony — nic nie zapisujemy w sesji, żeby ukryta cena nie
// zostawała odsłonięta „na później".
const clientDiscountToggleBtns = document.querySelectorAll('[id="clientDiscountToggleBtn"]');
let clientDiscountUnlocked = false;

function setClientDiscountVisible(visible) {
  document.querySelectorAll('.client-discount-row')
    .forEach(row => row.classList.toggle('d-none', !visible));
  clientDiscountToggleBtns.forEach(b => b.classList.toggle('active', visible));
}

async function checkLoginPassword(password) {
  try {
    const response = await fetch('/user/auth/check-login-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const result = await response.json();
    return !!result?.success;
  } catch (err) {
    console.warn(err);
    return false;
  }
}

clientDiscountToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const rows = document.querySelectorAll('.client-discount-row');
    if (!rows.length) return;

    // widoczne → chowamy bez pytania o hasło
    if (!rows[0].classList.contains('d-none')) {
      setClientDiscountVisible(false);
      return;
    }
    // hasło podane już wcześniej na tej stronie → nie pytamy drugi raz
    if (clientDiscountUnlocked) {
      setClientDiscountVisible(true);
      return;
    }

    const parent = document.getElementById('dialog-container');
    createInfoDialog({
      title: `${t('form.client_discount_unlock')}`,
      buttons: [
        {
          label: `${t('orders.abort')}`,
          className: 'btn btn-secondary me-1',
          id: 'cancel-btn'
        },
        {
          enter: true,
          label: `${t('order.unlock')}`,
          className: 'btn btn-success ms-1',
          id: 'confirm-btn',
          action: async () => {
            const value = passwordInput?.value?.trim() || '';
            if (!value) {
              showToast('error', `${t('order.invalid_password')}`);
              return;
            }
            if (await checkLoginPassword(value)) {
              clientDiscountUnlocked = true;
              setClientDiscountVisible(true);
            } else {
              showToast('error', `${t('order.invalid_password')}`);
            }
          }
        }
      ],
      parent,
      input: { name: `${t('login.password_label')}`, id: 'client-discount-password', type: 'password' },
      // Wąski, prawie kwadratowy monit — styl w public/styles/dialog.css
      className: 'compact-dialog'
    });
    const passwordInput = document.getElementById('client-discount-password');
  });
});

// --- Sub params toggle (przekierowanie do widoku z sub-params) ---
unlockSubBtns.forEach(unlockSubBtn => {
  unlockSubBtn.addEventListener('click', async () => await toggleSub())
});

async function toggleSub() {
  try {
    const response = await fetch('/orders/toggle-sub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (result.status === 'success') {
      window.location.reload();
    }
  } catch (err) {
    console.warn(err);
  }
}


async function movePosition(positionId, direction) {
  try {
    const response = await fetch(`/position/${positionId}/move-${direction}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (result.success) {
      showToast('success', result.message);
      
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } else if (result.redirect) {
      window.location.href = result.redirect;
    } else {
      showToast('error', result.message);
    }
  } catch (error) {
    showToast('error', t('order.move_position_error'));
    console.error('Error moving position:', error);
  }
}


moveUpBtns.forEach(btn => {
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const positionId = btn.dataset.id;
    await movePosition(positionId, 'up');
  });
});


moveDownBtns.forEach(btn => {
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const positionId = btn.dataset.id;
    await movePosition(positionId, 'down');
  });
});

document.addEventListener('DOMContentLoaded', () => {
  updateDiscountDisplay();
  if (discountBtn) {
    discountBtn.addEventListener('click', async () => {
      console.log('Kliknięto przycisk rabatu');
      await showDiscountModal();
    });
  } else {
    console.log('Element z id "discount-btn" nie został znaleziony (widok bez rabatów).');
  }

  const positions = document.querySelectorAll('.order-idx');
  positions.forEach(pos => {
    const positionId = pos.dataset.id;
    const idx = parseInt(pos.dataset.idx);
    setOrderPos(positionId, idx);
  });
});

async function setOrderPos(positionId, idx) {
  try {
    const response = await fetch(`/position/${positionId}/set-idx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idx: idx })
    });

    const result = await response.json();

    if (result.success) {
    } else if (!result.redirect) {
      showToast('error', result.message);
    }
  } catch (error) {
    showToast('error', t('order.set_position_order_error'));
    console.error('Error setting position order:', error);
  }
}

// --- Group shop: submit for approval ---
(function () {
    const btn = document.getElementById('submit-for-approval-btn');
    if (!btn) return;
    const parent = document.getElementById('dialog-container') || document.body;
    btn.addEventListener('click', function () {
        createInfoDialog({
            title: t('group.submit_for_approval_title'),
            message: t(gk('submit_for_approval_message')),
            parent,
            buttons: [
                { label: t('orders.abort'), className: 'btn btn-secondary me-1', id: 'cancel-btn' },
                {
                    label: t('orders.send_word'), className: 'btn btn-success ms-1', id: 'confirm-btn', enter: true,
                    action: async () => {
                        btn.disabled = true;
                        try {
                            const res = await fetch(`/orders/submit-for-approval/${btn.dataset.id}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' }
                            });
                            const data = await res.json();
                            if (data.success) {
                                showToast('success', t('group.submit_for_approval_success'));
                                setTimeout(() => { window.location.href = data.redirect || '/orders'; }, 800);
                            } else {
                                showToast('error', data.message || t('group.error_server'));
                                btn.disabled = false;
                            }
                        } catch (e) {
                            showToast('error', t('group.error_connection'));
                            btn.disabled = false;
                        }
                    }
                }
            ]
        });
    });
}());

// --- Group: approve / reject order ---
(function () {
    const approveBtn = document.getElementById('group-approve-btn');
    const rejectBtn = document.getElementById('group-reject-btn');
    if (!approveBtn && !rejectBtn) return;
    const parent = document.getElementById('dialog-container') || document.body;

    function performAction(url, actionBtn, successLabel, options = {}) {
        actionBtn.disabled = true;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ productionOrder: options.productionOrder === true })
        })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    showToast('success', successLabel);
                    setTimeout(() => { window.location.href = data.redirect || '/group/panel?tab=pending'; }, 900);
                } else {
                    showToast('error', data.message || t('group.error_server'));
                    actionBtn.disabled = false;
                }
            })
            .catch(() => {
                showToast('error', t('group.error_connection'));
                actionBtn.disabled = false;
            });
    }

    function openConfirm({ title, message, confirmLabel, confirmClass, action, useProductionOrder = false }) {
        const productionOrder = useProductionOrder && isProductionOrderSelected();
        createInfoDialog({
            title,
            message: getSendDialogMessage(message, productionOrder),
            parent,
            buttons: [
                { label: t('orders.abort'), className: 'btn btn-secondary me-1', id: 'cancel-btn' },
                { label: confirmLabel, className: confirmClass, id: 'confirm-btn', enter: true, action: () => action({ productionOrder }) }
            ]
        });
    }

    if (approveBtn) {
        approveBtn.addEventListener('click', () => {
            openConfirm({
                title: t('group.approve_send_title'),
                message: t('group.approve_send_message'),
                confirmLabel: `✓ ${t('group.approve_send_btn')}`,
                confirmClass: 'btn btn-success ms-1',
                useProductionOrder: true,
                action: (options) => performAction(`/group/approve-order/${approveBtn.dataset.id}`, approveBtn, t('group.approve_success'), options)
            });
        });
    }
    if (rejectBtn) {
        rejectBtn.addEventListener('click', () => {
            openConfirm({
                title: t('group.modal_reject_title'),
                message: t('group.modal_reject_body'),
                confirmLabel: t('group.reject_btn'),
                confirmClass: 'btn btn-danger ms-1',
                action: () => performAction(`/group/reject-order/${rejectBtn.dataset.id}`, rejectBtn, t('group.reject_success'))
            });
        });
    }
}()); 