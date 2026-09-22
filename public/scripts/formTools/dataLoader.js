

export class DataLoader {
  constructor() {
    this.params = null;
    this.dictValues = null;
    this.filters = {};
    this.parameterFilters = {};
    this.mainFiles = {
      param: 'param.txt',
      paramdict: 'paramdict.txt'
    }
  }

  checkEnv() {
    const envString = document.getElementById('env-info')
    if (envString?.value) {
      this.versionFile = -1
    }
  }

  async init(version, groupNumber, lang) {
    this.versionFile = version
    this.checkEnv()
    this.groupNumber = groupNumber
    this.lang = lang || 'pl';
    this.mainPath = `/data/${groupNumber}/data/versions/${version}/${this.lang}/`
    this.dictFile = `${this.mainFiles.paramdict}`
    this.paramFile = `${this.mainFiles.param}`
  }



  async loadData(file) {

    try {
      const response = await fetch(file);
      if (!response.ok) throw new Error("Błąd ładowania- " + response.status);
      const text = await response.text();

      const rows = text.split("\n");

      let data = [];
      for (let i = 0; i < rows.length; i++) {
        data.push(rows[i].split("\t"));
      }

      return data;
    } catch (error) {
      console.warn(`Błąd ładowania - brak pliku.`,);
      return null;
    }
  }

  /**
   * Podmiana wersji reguł, gdy tej z pozycji nie ma już na udziale.
   *
   * ⚠️ Stare wersje znikają z dysku, a `order_item.ver` trzyma numer z chwili
   * zapisu — zmierzone 2026-09-21: **522 zapisane pozycje** wskazują na wersje,
   * których nie ma w ŻADNYM środowisku (najnowsze z lutego 2026). Bez tego
   * `parseData()` zwracał `null` i `generateForm()` padał na `data.dictValues`:
   * użytkownik otwierający taką pozycję do edycji dostawał martwy ekran, bez
   * jednego komunikatu.
   *
   * Katalogu nie da się wylistować z przeglądarki, więc pyta o to serwer
   * (`routes/positions.js` → `/position/rules-version/...`). Podmiana jest
   * ZAPAMIĘTYWANA w `this.versionFallback`, bo reguły innej wersji mogą wycenić
   * pozycję inaczej niż w dniu zamówienia i człowiek musi to zobaczyć.
   */
  async resolveUsableVersion() {
    try {
      const url = `/position/rules-version/${this.groupNumber}/`
        + `?requested=${encodeURIComponent(this.versionFile ?? '')}&lang=${encodeURIComponent(this.lang)}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      return data && data.version ? data : null;
    } catch (error) {
      console.warn('Nie udało się ustalić zastępczej wersji reguł.', error);
      return null;
    }
  }

  async parseData() {
    let paramsData = await this.loadData(`${this.mainPath}${this.paramFile}`);
    let dictData = await this.loadData(`${this.mainPath}${this.dictFile}`);

    // Jedna próba podmiany — tylko gdy reguł faktycznie nie było.
    if ((!paramsData || !dictData) && !this.versionFallback) {
      const zastepcza = await this.resolveUsableVersion();
      if (zastepcza && zastepcza.fallback) {
        console.warn(`Reguły wersji ${this.versionFile} niedostępne — ${zastepcza.reason}`);
        this.versionFallback = zastepcza;
        this.mainPath = `/data/${this.groupNumber}/data/versions/${zastepcza.version}/${this.lang}/`;
        paramsData = await this.loadData(`${this.mainPath}${this.paramFile}`);
        dictData = await this.loadData(`${this.mainPath}${this.dictFile}`);
      }
    }

    if (!paramsData || !dictData) {
      console.error("Nie udało się wczytać CSV");
      return null;
    }

    console.log("CSV przetworzone");
    this.params = this.convertDataToObjects(paramsData,'param');
    this.dictValues = this.convertDataToObjects(dictData);
    return {
      params: this.params,
      dictValues: this.dictValues,
    };
  }

  convertDataToObjects(csvData, type='paramdict') {
    let headers = csvData[0];

    for (let header_idx = 0; header_idx < headers.length; header_idx++) {

      headers[header_idx] = headers[header_idx].replace(/\r/g, "");
    }

    let objects = [];

    for (let row = 1; row < csvData.length; row++) {
      let obj = {};

      for (let col = 0; col < headers.length; col++) {
        obj[headers[col]] = csvData[row][col] ? csvData[row][col] : null;
        if (type == 'param') {
          for (let [param, property] of Object.entries(obj)) {

            if (obj[param]) {
              obj[param] = (obj[param]).replace(/\r/g, "");

            }
          }
        }
      }
      objects.push(obj);
    }
    return objects;
  }

  convertDictValues(dictData) {
    let resultList = {};
    this.parameterFilters = {};

    if (!dictData || dictData.length === 0) {
      console.warn("Brak danych w słowniku");
      return resultList;
    }

    for (let i = 0; i < dictData.length; i++) {
      let row = dictData[i];

      for (let key in row) {
        if (row.hasOwnProperty(key)) {
          if (!key.endsWith("_VALUE")) {
            continue;
          }

          let paramName = key.replace("_VALUE", "");
          paramName= paramName.trim()
          let value = row[key];
          let description = row[paramName + "_DESCRIPTION"];

          if (value === "<NULL>") {
            value = null;
          }

          if (description === "<NULL>") {
            description = null;
          }

          if (value === null && description === null) {
            continue;
          }

          let enable = row[paramName + "_ENABLE"];
          let proc = row[paramName + "_PROC"];
          let attributes = row[paramName + "_ATTRS"];

          if (enable === "<NULL>") {
            enable = null;
          }

          if (proc === "<NULL>") {
            proc = null;
          }

          if (attributes === "<NULL>" || attributes === undefined || attributes === null) {
            attributes = null;
          } else {
            attributes = this.normalizeAttributes(attributes);
          }

          // <PARAM>_INFO — opis/plik przypisany do KONKRETNEJ WARTOSCI slownika
          // (odpowiednik param.INFO z param.txt, tylko per wartosc). Kolumna jest
          // nowa i nie ma jej jeszcze we wszystkich paramdictach, wiec brak
          // kolumny musi dawac null, a nie undefined - createInfoIcon nie rysuje
          // wtedy nic. \r bo convertDataToObjects czysci go tylko dla param.txt.
          let info = row[paramName + "_INFO"];
          if (info === "<NULL>" || info === undefined || info === null) {
            info = null;
          } else {
            info = String(info).replace(/\r/g, "").trim() || null;
          }

          let result = {
            ROW_NUM: row["ROW_NUM"],
            VALUE: value,
            DESCRIPTION: description,
            ENABLE: enable,
            PROC: proc,
            ATTRIBUTES: attributes,
            INFO: info,
          };

          if (!resultList[paramName]) {
            resultList[paramName] = [];
          }

          resultList[paramName].push(result);

          if (!this.parameterFilters[paramName]) {
            this.parameterFilters[paramName] = {};
          }

          if (attributes) {
            for (const [attrKey, attrValue] of Object.entries(attributes)) {
              if (!this.parameterFilters[paramName][attrKey]) {
                this.parameterFilters[paramName][attrKey] = [];
              }
              
              if (!this.parameterFilters[paramName][attrKey].includes(attrValue)) {
                this.parameterFilters[paramName][attrKey].push(attrValue);
              }
            }
          }

        }
      }
    }


    return resultList;
  }

  async checkCollection(param) {
    await formsManager.loadDataPerClient(param)
  }

  normalizeAttributes(string) {
    const result = {};
    if (typeof string !== 'string' || string.trim() === '') {
      return result;
    }
    let attrList = string.split('|');
    for (let pair of attrList) {
      if (pair && pair.includes('=')) {
        let x = pair.split('=');
        result[x[0]] = x[1];
      }
    }
    return result;
  }

  createParameterFilters(resultList) {
    this.parameterFilters = {};

    for (const [paramName, entries] of Object.entries(resultList)) {
      const filters = {};

      for (const entry of entries) {
        if (!entry.ATTRIBUTES) continue;

        for (const [attrKey, attrValue] of Object.entries(entry.ATTRIBUTES)) {

          if (!filters[attrKey]) {
            filters[attrKey] = new Set();
          }
          filters[attrKey].add(attrValue);
        }
      }


      this.parameterFilters[paramName] = {};
      for (const [key, values] of Object.entries(filters)) {
        this.parameterFilters[paramName][key] =
          Array.from(values).sort((a, b) => a.localeCompare(b));
      }
    }
  }

  async selectPrices(params) {

    if (!await formsManager.getClientScripts()) { return params }

    const [path, scripts] = await formsManager.getClientScripts()
    
    for (const param of params) {
      let scriptPath = scripts.find(script => script.param == param.NAME)

      if (param?.SCRIPTS == 'true' && scriptPath) {
        param.SOURCE = `${path}${scriptPath.file}`
      }
    }
    return params
  }



  async selectCollections(values) {
    const seen = new Set();
    const aliases = await formsManager.loadDataPerClient(this.groupNumber);

    const result = JSON.parse(JSON.stringify(values));


    for (const [param, aliasList] of Object.entries(aliases)) {
      if (result[param]?.length) {
        const exploded = [];
        
        result[param].forEach(valueEntry => {
          
          const matchedAliases = aliasList.filter(alias => alias.VALUE === valueEntry.VALUE);

          if (matchedAliases.length === 0) {
            
            return;
          } else if (matchedAliases.length === 1) {


            const newEntry = { ...valueEntry };
            newEntry.ALIAS = matchedAliases[0].ALIAS;
            newEntry.ALIAS_DESCRIPTION = matchedAliases[0].DESCRIPTION?.replace(/\r/g, '').trim();

            exploded.push(newEntry);
          } else {
            
            matchedAliases.forEach((aliasData, idx) => {
              const newEntry = { ...valueEntry };
              newEntry.ALIAS = aliasData.ALIAS;
              newEntry.ALIAS_DESCRIPTION = aliasData.DESCRIPTION?.replace(/\r/g, '').trim();
              if (newEntry.VALUE) {
                newEntry.VALUE = `${newEntry.VALUE}~${idx + 1}`;
              }


              exploded.push(newEntry);


            });
            
          }
        });

        if (exploded.length === 0) {
          delete result[param];
        } else {
          result[param] = exploded;
        }
      }
    }
    
    return result;
  }


  getFiltersForParameter(paramName) {
    if (!this.parameterFilters) return {};
    return this.parameterFilters[paramName] || {};
  }

  addFilters(name, filterObj) {
    this.filters[name] = filterObj;
  }


  getAllFilters() {
    
    return this.parameterFilters;
  }
}
