
import { DataLoader } from "./dataLoader.js";
import { showToast } from "../components/toast.js";

export class FormsManager {
    constructor() {
        this.mainPath = "/data";
        this.groupFilePath = '';
        this.groupFileName = 'prod.txt';
        this.paramFile = 'param.txt';
        this.paramDictFile = 'paramDict.txt';
        this.loader = new DataLoader();
        this.paths = [];
        this.aliases = {}
        // Aliasy (nakładki słowników) DOPASOWANE do aktualnej grupy i klienta.
        // Wypełnia je `loadDataPerClient()`. Musi istnieć od startu, bo
        // `getAliases()` bywa wołane zanim jakakolwiek grupa się wczyta.
        this.foundAliases = [];
        this.productUsers = [];
        this.clientData = {};
    }

    async getAvailableForms() {
        this.languages = window.langs || 'nl'
        this.language = document.documentElement.lang || 'pl';
        this.groupFilePath = `/data/data/${this.language}/group.txt`
        const data = await this.loader.loadData(this.groupFilePath);
        const objects = this.convertDataToObjects(data)
        this.departments = objects;
        this.paths = await this.getPaths();
        this.postAllPaths()

        this.clientData = await this.getOwner();
        window.currentUserIdent = this.clientData?.userIdent ?? '';
        console.log('DEBUG CLIENT DATA', this.clientData, this.departments, this.paths)
        return objects;
    }




    convertDataToObjects(csvData) {
        const filteredData = csvData.filter(row => row[0] && row[0].trim() !== '');
        const paramNames = filteredData.map(row => row[0].trim().toLowerCase());
        const numObjects = filteredData[0].length - 1;

        const objects = [];
        for (let col = 1; col <= numObjects; col++) {
            const obj = {};
            for (let row = 0; row < filteredData.length; row++) {
                let value = filteredData[row][col] ? filteredData[row][col].trim() : '';
                value = value.replace(/\r/g, '');
                obj[paramNames[row]] = value;
            }
            objects.push(obj);
        }
        for (const obj of objects) {

            if (obj?.products && obj.products !== "") {
                const products = obj.products.split(",");
                obj.products = products.map(product => product.trim());
            }
        }

        return objects;
    }
    // TUTUAJ
    setCurrentRootPath(groupNr) {
        this.currentRootPath = `${this.mainPath}/${groupNr}/data/`;
    }


    getCurrentRootPath() {
        return this.currentRootPath;
    }

    async loadDataPerClient(group) {
        // Zerujemy na wejściu, bo `this.foundAliases` opisuje TĘ grupę.
        // Funkcja ma dwa wyjścia, które nic nie przypisują (brak aliasów dla
        // grupy oraz brak dopasowania do klienta) — bez tego resetu zostawałyby
        // po nich aliasy z POPRZEDNIO otwartej grupy asortymentowej.
        this.foundAliases = [];

        // Nakładka kolekcji tkanin — ta sama zasada co przy skryptach cenowych.
        const overlay = await this.getTermsOverlay(group);
        const overlayCollections = Object.entries(overlay.collections || {}).filter(([, file]) => !!file);

        if (this.aliases?.[group] || overlayCollections.length) {

            let foundAliases = (this.aliases?.[group] || []).filter(entry =>
                entry.organization.trim().toUpperCase() === this.clientData.orgIdent.trim().toUpperCase() &&
                entry.client.trim().toUpperCase() === this.clientData.userIdent.trim().toUpperCase()

            );
                console.log('DEBUG ALIASES 1', foundAliases, 'clientData:', this.clientData)

            if (overlayCollections.length) {
                const byParam = new Map(foundAliases.map(entry => [entry.param, entry]));
                for (const [param, file] of overlayCollections) {
                    byParam.set(param, {
                        organization: this.clientData.orgIdent,
                        client: this.clientData.userIdent,
                        param,
                        file
                    });
                }
                foundAliases = [...byParam.values()];
            }

            if (!foundAliases.length) {
                console.warn('Brak pasujących aliasów dla:', this.clientData);
                return {};
            }
            this.foundAliases = foundAliases;
            const allObjects = {};

            for (const foundAlias of foundAliases) {
                try {
                    const aliasPath = `${this.currentRootPath}${foundAlias.file}`;
                    const arr = await this.loader.loadData(aliasPath);

                    const headers = arr[0].map(h => h.replace(/\r/g, '').trim());
                    const objects = arr.slice(1).map(row => {
                        const obj = {};
                        headers.forEach((header, idx) => {
                            obj[header] = (row[idx] || '').replace(/\r/g, '').trim();
                        });
                        return obj;
                    });

                    allObjects[foundAlias.param] = objects;
                } catch (error) {
                    // console.error(`Błąd podczas ładowania pliku ${foundAlias.file}:`, error);
                }
            }

            return allObjects;
        }
        else {
            return {}
        }
    }
    /**
     * Nakładka warunków handlowych z bazy — dla klientów zakładanych w eFormie,
     * których NIE ma w `prod.txt` (ten plik generuje aplikacja zewnętrzna).
     *
     * ⚠️ Bez tego formularz takiego klienta nie znajdzie skryptu ceny i pozycja
     * policzy się na 0 — dokładnie tak, jak przed nakładką zachowywał się silnik
     * importu. Endpoint zwraca wyłącznie dane klienta z bieżącej sesji/kontekstu
     * (patrz routes/clientTerms.js), więc nie da się nim podejrzeć cudzych cenników.
     *
     * Awaria/404 = pusta nakładka, czyli zachowanie sprzed zmiany.
     *
     * @param {string|number} groupNr
     * @returns {Promise<{scripts: Object, collections: Object}>}
     */
    async getTermsOverlay(groupNr) {
        this._overlayCache = this._overlayCache || {};
        if (this._overlayCache[groupNr]) return this._overlayCache[groupNr];

        let overlay = { scripts: {}, collections: {} };
        try {
            const response = await fetch(`/client-terms/${groupNr}`, { headers: { Accept: 'application/json' } });
            if (response.ok) {
                const data = await response.json();
                overlay = { scripts: data.scripts || {}, collections: data.collections || {} };
            }
        } catch (error) {
            console.warn('Nakładka cenników niedostępna — zostaje konfiguracja z prod.txt', error);
        }
        this._overlayCache[groupNr] = overlay;
        return overlay;
    }

    /**
     * Alias (nakładka słownika) przypisany do parametru w aktualnej grupie.
     *
     * ⚠️ `this.foundAliases` ustawia `loadDataPerClient()` WYŁĄCZNIE wtedy, gdy
     * znajdzie dopasowanie dla pary organizacja+klient. Dla grupy bez aliasów
     * (czyli dla większości klientów) pole zostawało `undefined`, a to wywołanie
     * rzucało `Cannot read properties of undefined (reading 'find')`. Wyjątek
     * leciał z `createFilterControls()` (dialogUtils_copy.js) i przerywał cały
     * łańcuch `initialize() → setupUI() → addSearchAndFilters()`, więc dialog
     * wyboru wartości w ogóle się nie budował.
     *
     * Zwracamy `{}`, a nie `[]`: jedyny konsument czyta z wyniku `.file`, więc
     * pusty obiekt jest uczciwym „brak aliasu" i nie kusi, żeby traktować
     * wynik jak listę.
     *
     * @param {string} paramName nazwa parametru (kolumna NAME z param.txt)
     * @returns {{organization?: string, client?: string, param?: string, file?: string}}
     */
    getAliases(paramName){
        return this.foundAliases?.find(alias => alias.param === paramName) || {};
    }
    async getClientScripts() {
        // Sprawdź czy this.groupsDetails istnieje i nie jest puste
        if (!this.groupsDetails || !Array.isArray(this.groupsDetails)) {
            console.warn('groupsDetails nie jest zdefiniowane lub nie jest tablicą');
            console.log('DEBUG SCRIPTS 1')
            return false;
        }

        // Sprawdź czy window.tempGroupNumber istnieje
        if (!window.tempGroupNumber) {
            console.log('DEBUG SCRIPTS 2')
            console.warn('window.tempGroupNumber nie jest zdefiniowane');
            return false;
        }

        const groupDetails = this.groupsDetails.find(group => group.code == window.tempGroupNumber);

        // Sprawdź czy grupa została znaleziona
        if (!groupDetails) {
            console.log('DEBUG SCRIPTS 3')
            console.warn(`Nie znaleziono grupy z kodem: ${window.tempGroupNumber}`);
            return false;
        }

        this.scriptsArr = groupDetails.param_scripts;
        let foundScripts = [];

        if (this.scriptsArr) {
            foundScripts = this.scriptsArr.filter(entry =>
                entry.organization.trim().toLowerCase() === this.clientData.orgIdent.trim().toLowerCase() &&
                entry.client.trim().toLowerCase() === this.clientData.userIdent.trim().toLowerCase()
            );
        }

        // Nakładka z bazy dokłada/zastępuje wpisy per parametr. Scalamy PRZED
        // testem „brak wpisów", bo klient założony w eFormie ma w prod.txt zero
        // wierszy i bez nakładki wyszlibyśmy stąd z `false` (cena = 0).
        const overlay = await this.getTermsOverlay(window.tempGroupNumber);
        if (overlay.scripts && Object.keys(overlay.scripts).length) {
            const byParam = new Map(foundScripts.map(entry => [entry.param, entry]));
            for (const [param, file] of Object.entries(overlay.scripts)) {
                if (!file) continue;
                byParam.set(param, {
                    organization: this.clientData.orgIdent,
                    client: this.clientData.userIdent,
                    param,
                    file
                });
            }
            foundScripts = [...byParam.values()];
        }

        if (!foundScripts.length) {
            console.log('DEBUG SCRIPTS 4')

            console.warn('Brak pasujących aliasów dla:', this.clientData);
            return false;
        }

        let path = this.currentRootPath;
        return [path, foundScripts];
    }

    async getPaths() {
        const paths = [];

        for (const department of this.departments) {
            for (const asortment of department.products) {
                const groupObj = { [asortment]: [] };

                for (const lang of this.languages) {
                    const path = `/${asortment}/data/${lang}/`;
                    groupObj[asortment].push(path);
                }

                paths.push(groupObj);
            }
        }
        return paths;
    }

    async getGroups(departmentNumber) {
        const objects = []
        const department = this.departments.find(department => department.num === departmentNumber);
        const user = this.clientData.userIdent

        for (const asortment of department.products) {
            const path = `${this.mainPath}/${asortment}/data/${this.language}/`
            const prodFilePath = `${path}${this.groupFileName}`;
            try {

                const data = await this.loader.loadData(prodFilePath);
                const object = this.convertDataToObjects(data)[0];
                console.log('DEBUG GROUP OBJECT', object)

                if (object.paramdict_aliases) {

                    this.aliases[asortment] = await this.prepareData(object.paramdict_aliases)
                    object.paramdict_aliases = this.aliases[asortment]
                }

                if (object?.users) {
                    this.productUsers = object.users
                        .split(',')
                        .map(u => u.trim().toUpperCase());
                    const currentUser = user.toUpperCase();

                    if (!this.productUsers.includes(currentUser) && object?.users) {
                        continue
                    }
                }
                if (object.param_scripts) {
                    this.scriptsArr = await this.prepareData(object.param_scripts) ?? []
                    object.param_scripts = this.scriptsArr

                }
                this.paths.push(path);
                objects.push(object);
            }
            catch (error) {
                showToast('warning', `Brak plików dla grupy ${asortment}`);

            }
        }
        this.groupsDetails = objects;

        return objects
    }

    setCurrentGroup(groupNumber) {
        this.currentGroup = this.groupsDetails.find(group => group.code == groupNumber)


    }

    async getUserIdent() {
        return this.clientData.userIdent;
    }
    async getOrgIdent() {
        return this.clientData.orgIdent;
    }
    async prepareData(strings) {
        const arr = [];
        const stringList = strings.split(',');

        for (let string of stringList) {
            string = string.trim();
            const [data, file] = string.split('=');
            const [org, client, param] = data.split('/');

            arr.push({
                organization: org,
                client: client,
                param: param,
                file: file
            });
        }

        return arr;
    }

    async postAllPaths() {
        try {
            const response = await fetch('/position/versions/update/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(this.paths)
            });

            if (!response.ok) throw new Error('Błąd serwera');
            return await response.json();

        } catch (error) {
            console.error('Błąd podczas wysyłania ścieżek:', error);
            throw error;
        }
    }

    async getOwner() {
        try {

            const response = await fetch('/user/owner/');


            if (!response.ok) {
                let errorMsg = 'Błąd serwera';
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.message || errorMsg;
                } catch { }
                throw new Error(errorMsg);
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.message || 'Nieznany błąd');
            }
            return data.idents;

        } catch (error) {
            console.error('Błąd podczas pobierania właściciela:', error.message);
            throw error;
        }
    }

    getGroupTextAndGroupDesc(groupNumber, departmentNumber) {
        //    console.log('resume', groupNumber, departmentNumber, this.groupsDetails, this.departments)
        this.currentGroup = this.groupsDetails.find(group => group.code == groupNumber)
        this.currentDepartment = this.departments.find(dept => dept.num == departmentNumber)
        // console.log('siemanko 4 ','currentGroup:', this.currentGroup, 'currentDepartment:', this.currentDepartment)
        return {
            groupText: this.currentGroup.description,
            deptText: this.currentDepartment.description
        }
    }

}

