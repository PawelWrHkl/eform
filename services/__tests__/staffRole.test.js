'use strict';

/**
 * Konto biura (rola `staff`): kontekst klienta jak admin, ceny jak admin,
 * uprawnienia nie (prompt biura, punkty A i E).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const MailComposer = require('nodemailer/lib/mail-composer');

const { getCurrentUser } = require('../owner');
const { applySubPriceLocals, canSeeAllPriceLayers } = require('../subPriceContext');
const { resolveSubPricePdfView } = require('../subPrices');
const { describeActor, canRoleCancel } = require('../orderCancellation');
const { resolveStaffCopy, resolveConfirmationRecipients } = require('../confirmationPolicy');
const { canAccessInvoices } = require('../invoices/access');
const { resolveAudience } = require('../pricelists/audience');
const { getActiveGroupShopId } = require('../groupContext');
const { normalizeUserSettings, ROLE_OPTIONS, normalizeNewStaffAccount } = require('../admin/userAdminService');
const { buildMailOptions } = require('../mailBot/mailBot');

const staff = { userId: 10, ident: 'STAFF_ANNA', pin: 'anna', orgId: 3, organization: 'HKL', isStaff: true, isOwner: false, isAdmin: false, isGroup: false };
const klientLuxan = { userId: 7, ident: 'KLIENT_L', orgId: 5, organization: 'LUXANGMBH', isGroup: false };

test('getCurrentUser: biuro z kontekstem pracuje za klienta, bez kontekstu — na swoim koncie', () => {
    assert.equal(getCurrentUser({ session: { user: staff, context_user: klientLuxan } }), klientLuxan);
    assert.equal(getCurrentUser({ session: { user: staff } }), staff);
});

test('getCurrentUser: zwykły klient z podrzuconym context_user nadal widzi tylko siebie', () => {
    const klient = { userId: 99, ident: 'X', orgId: 5 };
    assert.equal(getCurrentUser({ session: { user: klient, context_user: klientLuxan } }), klient);
});

test('ceny jak admin: kłódka, ceny katalogowe i SUB w kontekście klienta spoza HKL', () => {
    assert.equal(canSeeAllPriceLayers(staff), true);
    assert.equal(canSeeAllPriceLayers({ isAdmin: true }), true);
    assert.equal(canSeeAllPriceLayers({ isOwner: true }), false);
    assert.equal(canSeeAllPriceLayers(null), false);

    const asStaff = { locals: {} };
    applySubPriceLocals({ session: { user: staff, context_user: klientLuxan } }, asStaff);
    const asAdmin = { locals: {} };
    applySubPriceLocals({ session: { user: { userId: 1, orgId: 3, organization: '3', isAdmin: true, isOwner: true }, context_user: klientLuxan } }, asAdmin);
    for (const key of ['isClient', 'isHklClient', 'viewAsOrganization', 'hasSubPriceToggle', 'showCatalogPrices', 'canViewSubPrices']) {
        assert.equal(asStaff.locals[key], asAdmin.locals[key], key);
    }
    assert.equal(asStaff.locals.isHklClient, false, 'biuro z organizacji HKL nie jest „klientem HKL" bez kłódki');
    assert.equal(asStaff.locals.viewAsOrganization, true);
});

test('PDF/mail: biuro w kontekście klienta spoza HKL widzi to co admin, nie widok klienta', () => {
    const view = resolveSubPricePdfView({ session: { user: staff, context_user: klientLuxan } }, true);
    assert.equal(view.isPureClient, false);
    assert.equal(view.hasSubToggle, true);
});

test('uprawnienia admina zostają zamknięte: faktury, cenniki PDF klientów, konta podrzędne grup', () => {
    assert.equal(canAccessInvoices(staff, { invoices: true, invoicesAdminOnly: false }), false);
    assert.equal(canAccessInvoices({ userId: 3 }, { invoices: true, invoicesAdminOnly: false }), true, 'zwykły klient bez zmian');
    assert.equal(resolveAudience({ user: staff, context_user: klientLuxan }), null);
    const grupa = { ...klientLuxan, isGroup: true };
    assert.equal(getActiveGroupShopId({ session: { user: staff, context_user: grupa, group_shop_context: { id: 44 } } }), null);
});

test('anulowanie: biuro może, a w audycie zostaje konto biura i klient', () => {
    assert.equal(canRoleCancel(staff), true);
    assert.equal(describeActor({ sessionUser: staff, contextUser: klientLuxan }), 'staff:STAFF_ANNA -> KLIENT_L');
});

test('rola „Biuro" do nadania w panelu admina', () => {
    assert.ok(ROLE_OPTIONS.some((o) => o.value === 'staff'));
    assert.equal(normalizeUserSettings({ role: 'Staff' }).values.role, 'staff');
});

test('nowe konto biura: PIN = login (3–12 bezpiecznych znaków), nazwa, opcjonalny e-mail, hasło', () => {
    const ok = normalizeNewStaffAccount({ pin: 'anna.k', name: 'Anna Kowalska', email: 'anna@hkl.eu', password: 'tajnehaslo', password2: 'tajnehaslo' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.values, { pin: 'anna.k', clientName: 'Anna Kowalska', email: 'anna@hkl.eu' });
    const bad = normalizeNewStaffAccount({ pin: 'a b', name: '', email: 'zly', password: 'krotkie', password2: 'inne' });
    assert.deepEqual(bad.errors, ['staff.admin.error_pin', 'staff.admin.error_name', 'staff.admin.error_email', 'staff.admin.error_password']);
});

test('kopia potwierdzenia dla biura: ukryte BCC; na dev/test tylko skrzynka testowa', () => {
    assert.deepEqual(resolveStaffCopy({ env: 'production', staffEmail: ' anna@hkl.eu ' }), { bcc: 'anna@hkl.eu', reason: 'ok' });
    assert.deepEqual(resolveStaffCopy({ env: 'production', staffEmail: '' }), { bcc: null, reason: 'no_email' });
    assert.deepEqual(resolveStaffCopy({ env: 'test', staffEmail: 'anna@hkl.eu' }), { bcc: null, reason: 'redirected' });
    assert.deepEqual(resolveStaffCopy({ env: 'test', staffEmail: 'Pawel.Woroniecki@hkl.eu' }), { bcc: 'Pawel.Woroniecki@hkl.eu', reason: 'ok' });
    // Reguły odbiorców klienta bez zmian
    assert.equal(resolveConfirmationRecipients({ env: 'test' }).mainRecipient, 'pawel.woroniecki@hkl.eu');
});

test('mailBot: options.bcc trafia do koperty, ale nie do nagłówków widocznych dla klienta', async () => {
    const options = buildMailOptions('klient@example.com', 'pl', Buffer.alloc(10, 0x41), [], { orderNr: '1', klient: 'X', logoPath: '/nonexistent.png' },
        'org@example.com', 'mailTemplate.njk', 'mail.subject', { htmlContent: '<p>x</p>', bcc: 'anna@hkl.eu' });
    assert.equal(options.bcc, 'anna@hkl.eu');
    assert.equal(options.cc, 'org@example.com');
    const message = await new Promise((resolve, reject) => {
        new MailComposer(options).compile().build((err, msg) => (err ? reject(err) : resolve(msg.toString('binary'))));
    });
    const headers = message.split('\r\n\r\n')[0];
    assert.match(headers, /Cc: org@example\.com/);
    assert.doesNotMatch(headers, /anna@hkl\.eu/);

    const bezKopii = buildMailOptions('k@example.com', 'pl', Buffer.alloc(1), [], { orderNr: '1', klient: 'X', logoPath: '/x.png' },
        null, 'mailTemplate.njk', 'mail.subject', { htmlContent: '<p>x</p>' });
    assert.equal('bcc' in bezKopii, false, 'bez konta biura nic się nie zmienia');
});
