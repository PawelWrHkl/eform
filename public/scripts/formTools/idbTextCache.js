/**
 * Magazyn kopii plików tekstowych (param.txt/paramdict.txt/prod.txt/group.txt)
 * dla `DataLoader.loadData()` — IndexedDB, NIE `localStorage`.
 *
 * ⚠️ Zmierzone 2026-09-25: samo `prod.txt` KAŻDEJ grupy asortymentowej to
 * ~800 KB-1 MB, a grup jest kilkanaście — przeglądarka pyta o `prod.txt`
 * WSZYSTKICH grup danego działu już przy samym budowaniu listy rozwijanej
 * (`FormsManager.getGroups()`), zanim użytkownik cokolwiek otworzy. Jeden
 * dział to już ~5 MB — dokładnie limit typowego `localStorage` (5-10 MB na
 * origin). IndexedDB ma limit liczony w dziesiątkach/setkach MB (procent
 * wolnego miejsca na dysku), więc jest tu jedynym realistycznym wyborem —
 * `localStorage` przestałby cache'ować (cicho, przez `QuotaExceededError`)
 * już po jednym-dwóch działach.
 */

const DB_NAME = 'eform-offline-cache';
const STORE_NAME = 'text-files';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB niedostępne w tej przeglądarce'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

/** @returns {Promise<boolean>} czy zapis się udał — wołający ma być best-effort, nigdy nie wywraca normalnego ładowania. */
export async function idbSetText(key, value) {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (err) {
        console.warn('idbTextCache: zapis nieudany —', err.message);
        return false;
    }
}

/** @returns {Promise<*|null>} */
export async function idbGetText(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
    } catch (_err) {
        return null;
    }
}
