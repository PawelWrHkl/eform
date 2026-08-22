const express = require("express");
const path = require("path");
const nunjucks = require("nunjucks");
const dotenv = require("dotenv").config();
const session = require("express-session");
const app = express();
const cors = require('cors');
const ordersRoutes = require('./routes/orders');
const positionsRoutes = require('./routes/positions');
const userRoutes = require('./routes/users');
const mainRoutes = require('./routes/index');
const adminRoutes = require('./routes/admin');
const addressRoutes = require('./routes/address');
const invoiceRoutes = require('./services/invoices/http/routes');
const invoicePanelRoutes = require('./services/invoices/http/panel');
const orgCustomersRoutes = require('./routes/orgCustomers');
const clientTermsRoutes = require('./routes/clientTerms');
// Znacznik wersji zasobów: zmienia się przy każdym starcie procesu, czyli po
// każdym wdrożeniu (`update.sh` restartuje kontener, `--watch` proces hosta).
const ASSET_VERSION = Date.now().toString(36);
const groupRoutes = require('./routes/group');
const { addOrganizationsForAdmin } = require('./middleware/loginMixture.js');
const usersDb = require('./db/users.js');
const groupDb = require('./db/group.js');
const bodyParser = require("body-parser");
const { photoPath, dataDir, localesDir, availabeLanguages, defaultLanguage } = require('./config');
const cookieParser = require('cookie-parser');
const i18n = require('i18n');
const nunjucksSetup = require('./nunjucks-setup');
const { default: I18NexFsBackend } = require("i18next-fs-backend");
const { log } = require('./utils/logging');
const sessionService = require('./services/sessionService');
const sessionStore = new session.MemoryStore();
sessionService.setStore(sessionStore);


i18n.configure({
	locales: availabeLanguages,
	directory: localesDir,
	defaultLocale: defaultLanguage,
	cookie: 'lang',
	register: global,
	queryParameter: 'lang',
	objectNotation: true,
	autoReload: true

});


app.use(cookieParser())
app.use(i18n.init)

app.use(cors({
	origin: 'http://192.168.0.8',
	methods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PUT'],
	credentials: true
}));
app.use((req, res, next) => {
	res.locals.locale = defaultLanguage;
	i18n.setLocale(req, req.cookies.lang || defaultLanguage);
	next();
});

const env = nunjucksSetup.configure(app);

app.set('view engine', 'njk');

log('defaultLanguage =', i18n.getLocale());

if (process.env.PRODUCTION) {
	log('tu')
	app.use(session({
		store: sessionStore,
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		cookie: {
			secure: false,
			httpOnly: true,
			sameSite: "lax",
			maxAge: 1000 * 60 * 60 * 8,
			domain: "e-orders.eu"
		}
	}));
	app.set('trust proxy', 1);
}

else if (process.env.TEST_INTERNET) {
	log('tu 2')
	app.use(session({
		store: sessionStore,
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		cookie: {
			secure: false,
			httpOnly: true,
			sameSite: "lax",
			maxAge: 1000 * 60 * 60 * 8,
			domain: "eform.tkproject.eu"
		}
	}));
	app.set('trust proxy', 1);
}

else {
	log('tu3')
	app.use(session({
		store: sessionStore,
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		cookie: {
			secure: false,
			httpOnly: true,
			sameSite: "lax",
			maxAge: 1000 * 60 * 60 * 8,
			// domain: "eform.tkproject.eu" 
		}
	}));
}
const { getClientIp } = require('./utils/getClientIp');
app.use((req, res, next) => {
	if (req.session?.user?.pin) {
		req.session.clientIp = getClientIp(req);
	}
	next();
});
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static(path.join(__dirname, "public")));
app.use('/data', express.static(dataDir));
app.use('/photos', express.static(photoPath));

log('→ dataDir =', dataDir);



app.use((req, res, next) => {
	res.locals.locale = req.getLocale();
	next();
});

const { normalizeGroupType, GROUP_TYPE_CLIENT } = require('./services/groupType');

// ─── group flags global middleware ──────────────────────────────────────────
// Make isGroup/isGroupShop available in every template (incl. /group/* views),
// so that nav items remain visible across all pages for group users.
app.use((req, res, next) => {
	res.locals.isGroup = req.session?.user?.isGroup || req.session?.context_user?.isGroup || false;
	res.locals.isGroupShop = req.session?.user?.isGroupShop || false;
	// Odmiana modułu grupowego (`user.group_type`): decyduje o TREŚCI stron
	// grupy — `shop` zostaje jak dotąd, `client` mówi wszędzie „klient".
	// Kontekst (admin/owner oglądający grupę) liczy się tak samo jak sesja,
	// inaczej panel oglądany przez admina wracałby do brzmienia „sklep".
	res.locals.groupType = normalizeGroupType(
		req.session?.context_user?.groupType || req.session?.user?.groupType
	);
	res.locals.isGroupClientType = res.locals.groupType === GROUP_TYPE_CLIENT;
	// Konto podrzędne grupy typu `client` nie widzi w navbarze DANYCH
	// GRUPY-MATKI (nazwa + mail) — dla klienta grupy są mylące. Sam blok
	// `user-info` zostaje: nazwa filii (konta) nadal się w nim wyświetla,
	// patrz public/scripts/base.js.
	res.locals.hideUserInfo = !!(res.locals.isGroupShop && res.locals.isGroupClientType);
	// Konto organizacyjne: userIdent === orgIdent (użytkownik jest jednocześnie organizacją)
	const u = req.session?.user;
	res.locals.isOrgAccount = !!(
		u &&
		typeof u.ident === 'string' &&
		typeof u.organization === 'string' &&
		u.ident.toLowerCase() === u.organization.toLowerCase()
	);
	next();
});

// ─── feature flags global middleware ────────────────────────────────────────
// One place makes `features.vat` (config.js) visible to every template, so a
// disabled feature leaves no trace in any rendered page.
const { features } = require('./config');
app.use((req, res, next) => {
	res.locals.vatEnabled = !!features?.vat;
	// Konto podrzędne grupy (`group_user`) nie ma dostępu do fakturowania ani
	// do kartoteki odbiorców końcowych — składa wyłącznie zamówienia. Flaga
	// gasi zarówno wejście w menu, jak i sekcję odbiorcy w formularzu
	// zamówienia (`invoicesEnabled` bramkuje oba miejsca), a same trasy
	// `/invoices` i `/api/v1/invoices` odcina `blockGroupShop` niżej.
	const isGroupShopSession = !!req.session?.user?.isGroupShop;
	res.locals.invoicesEnabled = !!features?.invoices && !isGroupShopSession;
	res.locals.orgCustomersEnabled = !!features?.orgCustomers && !isGroupShopSession;
	// ⚠️ Warunek widoczności wejścia w menu MUSI być liczony tutaj, a nie
	// z `owner`/`admin` w szablonie: `owner` jest lokalną zmienną pojedynczego
	// renderu (`routes/index.js` ustawia je tylko dla strony głównej), a `admin`
	// dokłada `addOrganizationsForAdmin` wyłącznie adminom. Oparcie linku na nich
	// dawało pozycję w menu widoczną na stronie głównej i znikającą na każdej
	// innej. Sesja jest jedynym źródłem dostępnym przy każdym renderze.
	const sessionUser = req.session && req.session.user;
	res.locals.canManageCustomers = !!(features?.orgCustomers && sessionUser
		&& !sessionUser.isGroupShop
		&& (sessionUser.isOwner || sessionUser.isAdmin));
	// Wersja zasobów do cache-bustingu (`?v=`) — bez tego przeglądarka trzyma
	// stary plik JS po wdrożeniu, co objawia się błędami z nieaktualnej wersji
	// (np. panel salonu pytający o endpoint dla ownera).
	res.locals.assetVersion = ASSET_VERSION;
	next();
});

// ─── kontekst konta podrzędnego grupy ───────────────────────────────────────
// Grupa (`role = 'group'`) pracuje „jako" swój sklep/klient — tak jak admin
// w kontekście klienta. Lista kont i aktywny kontekst muszą być dostępne przy
// KAŻDYM renderze, bo wybór siedzi w navbarze (jak lista klientów u ownera).
// ⚠️ Zapytanie leci tylko dla sesji grupowej i tylko dla żądań o HTML —
// nie chcemy go na każdym fetchu JSON-owym.
const { getGroupShopContext } = require('./services/groupContext');
app.use(async (req, res, next) => {
	res.locals.groupShopContext = null;
	res.locals.groupShops = [];
	try {
		if (res.locals.isGroup) {
			res.locals.groupShopContext = getGroupShopContext(req);
			if (req.method === 'GET' && req.accepts('html')) {
				const parentUserId = req.session?.context_user?.userId || req.session?.user?.userId;
				if (parentUserId) {
					const shops = await groupDb.getGroupUsersByParentId(parentUserId);
					// Do navbara idą TYLKO pola, które on wypisuje. `group_user`
					// niesie też `plain` (hasło w jawnej postaci dla przycisku
					// „kopiuj dane logowania" w panelu) — nie ma powodu, żeby
					// krążyło w locals każdej strony.
					res.locals.groupShops = (shops || []).map(s => ({ id: s.id, ident: s.ident, name: s.name }));
				}
			}
		}
	} catch (err) {
		log('[groupContext] nie udało się wczytać kont podrzędnych:', err.message);
	}
	next();
});

const { applySubPriceLocals } = require('./services/subPriceContext');
app.use((req, res, next) => {
	applySubPriceLocals(req, res);
	next();
});

// ─── intro_needed global middleware ─────────────────────────────────────────
app.use(async (req, res, next) => {
	const pin = req.session?.user?.pin;
	if (pin) {
		try {
			req.session.user.introNeeded = await usersDb.getIntroNeeded(pin);
			// log('[intro] pin:', pin, 'introNeeded:', req.session.user.introNeeded);
		} catch (e) {
			log('[intro] DB error:', e.message);
			req.session.user.introNeeded = false;
		}
		res.locals.introNeeded = req.session.user.introNeeded;
	} else {
		res.locals.introNeeded = null;
	}
	next();
});

app.use(addOrganizationsForAdmin);
const { enforceAccessLock } = require('./middleware/accessLock');
app.use(enforceAccessLock);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/group', groupRoutes);
app.use('/', mainRoutes);
app.use('/orders', ordersRoutes);
app.use('/position', positionsRoutes);
app.use('/address', addressRoutes);
// Moduł fakturowania — REST API (patrz services/invoices/README.md).
// Montowany na końcu, bo `app.all('*')` poniżej przechwytuje wszystko pozostałe.
//
// ⚠️ MONTOWANY WARUNKOWO: przy `INVOICES_ENABLED != true` moduł ma być
// niedostępny w całości, a nie tylko schowany w menu. Wcześniej routery
// stały zawsze i chronił je wyłącznie login — adres `/invoices` wpisany
// z palca działał także tam, gdzie moduł miał być wyłączony.
// Konto podrzędne grupy (`group_user`) nie ma dostępu do fakturowania ani do
// odbiorców końcowych — samo schowanie wejścia w menu nie wystarcza, bo adres
// wpisany z palca nadal by działał (te trasy chroni tylko `requireLogin`,
// a konto podrzędne JEST zalogowane, w sesji rodzica-grupy).
function blockGroupShop(req, res, next) {
	if (req.session?.user?.isGroupShop) {
		if (req.accepts('html') && !req.xhr) {
			return res.status(403).render('error.njk', { message: 'Brak dostępu' });
		}
		return res.status(403).json({ success: false, message: 'Brak dostępu' });
	}
	return next();
}

if (features?.invoices) {
	app.use('/api/v1/invoices', blockGroupShop, invoiceRoutes);
	// Panel ownera dla faktur (widoki HTML; dane bierze z API powyżej)
	app.use('/invoices', blockGroupShop, invoicePanelRoutes);
	log('[invoices] moduł włączony (INVOICES_ENABLED=true)');
} else {
	log('[invoices] moduł WYŁĄCZONY — /invoices i /api/v1/invoices nie są montowane');
}

// Moduł „Klienci organizacji" — ta sama zasada co wyżej: przy wyłączonej fladze
// router w ogóle nie wstaje, więc `/org/customers` zwraca 404 zamiast ekranu
// chronionego samym loginem.
if (features?.orgCustomers) {
	app.use('/org/customers', blockGroupShop, orgCustomersRoutes);
	// Nakładka cenników dla formularza w przeglądarce — dostępna dla KAŻDEGO
	// zalogowanego (formularz otwiera też klient i pracownik), zawężona do
	// klienta z sesji/kontekstu. Patrz routes/clientTerms.js.
	app.use('/client-terms', clientTermsRoutes);
	log('[orgCustomers] moduł włączony (ORG_CUSTOMERS_ENABLED=true)');
} else {
	log('[orgCustomers] moduł WYŁĄCZONY — /org/customers nie jest montowany');
}


app.all('*', (req, res) => {
	const status = 404;
	const message = "Page not found.";
	const attemptedPath = req.originalUrl;
	res.status(status).render('error.njk', {
		status,
		message,
		attemptedPath
	});
});

app.use((err, req, res, next) => {
	log(err);
	const status = err.status || 500;
	const message = err.message || "Serwer error.";
	const attemptedPath = req.originalUrl;

	res.status(status).render('error.njk', {
		status,
		message,
		attemptedPath
	});
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	log(`Server działa na porcie ${PORT}`);
});

module.exports = {
	app,
	env,
	i18n
};