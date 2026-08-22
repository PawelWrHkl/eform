/**
 * Odmiana modułu grupowego — kolumna `user.group_type`.
 *
 * `shop`   — klasyczna grupa: konta podrzędne (`group_user`) to sklepy/filie.
 * `client` — ta sama mechanika, ale konta podrzędne to KLIENCI grupy, więc
 *            cała treść panelu mówi „klient", a nie „sklep".
 *
 * ⚠️ Różnica jest wyłącznie w warstwie treści (etykiety) i w tym, czego konto
 * podrzędne nie widzi w nawigacji — logika zamówień, zatwierdzania i wysyłki
 * jest wspólna. Puste/nieznane `group_type` znaczy `shop`, bo istniejące konta
 * grupowe (np. TCN) nie mogą zmienić wyglądu panelu przez brak wartości.
 */

const GROUP_TYPE_SHOP = 'shop';
const GROUP_TYPE_CLIENT = 'client';

function normalizeGroupType(value) {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return v === GROUP_TYPE_CLIENT ? GROUP_TYPE_CLIENT : GROUP_TYPE_SHOP;
}

function isClientGroupType(value) {
    return normalizeGroupType(value) === GROUP_TYPE_CLIENT;
}

/**
 * Klucze z przestrzeni `group.*`, które w odmianie `client` mają własne
 * brzmienie (`group.client.*`). Lista jest jawna, bo `__()` zwraca sam klucz,
 * gdy tłumaczenia nie ma — bez niej literówka w nazwie klucza pokazałaby
 * użytkownikowi surowe `group.client.cos` zamiast tekstu.
 */
const CLIENT_LABEL_KEYS = new Set([
    'panel_subtitle',
    'shops_label',
    'tab_shops',
    'add_shop_btn',
    'add_first_shop_btn',
    'back_to_shops',
    'filter_all_shops',
    'filter_aria',
    'filter_shop_label',
    'col_shop',
    'alert_shop_added',
    'alert_shop_updated',
    'alert_shop_deleted',
    'alert_shop_notfound',
    'error_delete',
    'modal_delete_shop_title',
    'modal_delete_shop_q',
    'modal_delete_shop_confirm',
    'modal_reject_body',
    'modal_reject_warn',
    'no_orders_active_desc',
    'no_orders_sent_desc',
    'no_shops_title',
    'no_shops_desc',
    'shops_empty',
    'shops_page_title',
    'show_shop_orders_title',
    'pending_empty_desc',
    'pending_h2',
    'shop_form_title_new',
    'shop_form_title_edit',
    'sf_shop_name',
    'sf_shop_name_hint',
    'sf_shop_name_placeholder',
    'sf_save_new',
    'shop_orders_h2',
    'shop_orders_page_title',
    'shop_orders_empty_active',
    'shop_orders_empty_sent',
    'submit_for_approval_message',
    'form_error_add_shop',
    'context_select_label',
    'context_select_placeholder',
    'context_hint',
]);

/**
 * Zwraca pełny klucz tłumaczenia dla etykiety modułu grupowego.
 * Przyjmuje zarówno `tab_shops`, jak i `group.tab_shops`.
 */
function groupLabelKey(key, groupType) {
    const short = String(key || '').replace(/^group\./, '');
    if (isClientGroupType(groupType) && CLIENT_LABEL_KEYS.has(short)) {
        return `group.client.${short}`;
    }
    return `group.${short}`;
}

module.exports = {
    GROUP_TYPE_SHOP,
    GROUP_TYPE_CLIENT,
    normalizeGroupType,
    isClientGroupType,
    groupLabelKey,
    CLIENT_LABEL_KEYS,
};
