import {
    setDescription
} from "./formTools.js";
export function loadScript(scriptFile, values, displayValues, groupNumber, allOptionsByParameter, param, callback) {



    const scriptPath = scriptFile;
    const script = document.createElement('script');

    script.crossOrigin = 'anonymous';
    script.src = scriptPath;
    console.log('Ładowanie skryptu:', scriptPath, 'z wartościami:', values, 'i displayValues:', displayValues, 'dla grupy numer:', groupNumber);
    const scriptInput = prepareValuesForScript(values, displayValues, allOptionsByParameter);


    let finished = false;


    const handleGlobalError = (event) => {
        if (event.filename && event.filename.includes(scriptPath) && !finished) {
            console.error('Globalny błąd skryptu:', event.message || event.error);
            finished = true;
            window.removeEventListener('error', handleGlobalError);
            callback(errorShield(scriptPath, param));

        }
    };
    window.addEventListener('error', handleGlobalError);

    script.onload = () => {

        if (finished) return;
        try {
            if (typeof f === 'function') {

               const result = f(scriptInput);
                console.log(result, 'result z scriptLoader', script);
                                
                console.log('Wynik funkcji f ze skryptu', result);
                const roundedResult = roundPrices(result);
                finished = true;
                console.log(roundedResult, 'roundedResult z scriptLoader');
                callback(roundedResult);

            } else {
                console.error('Funkcja f nie została znaleziona!');
                finished = true;
                callback(errorShield(scriptPath, param));
            }
        } catch (err) {
            console.error('Błąd podczas wykonywania f:', err);
            finished = true;
            callback(errorShield(scriptPath, param));
        } finally {
            window.removeEventListener('error', handleGlobalError);
        }
    };

    script.onerror = () => {
        if (!finished) {
            console.error('Błąd ładowania lub parsowania skryptu:', scriptFile);
            finished = true;
            window.removeEventListener('error', handleGlobalError);
            callback(errorShield(scriptPath, param));
        }
    };

    document.body.appendChild(script);
}

function prepareValuesForScript(values, displayValues, allOptionsByParameter) {
    values['uid'] = window.uid;
    for (let [paramName, value] of Object.entries(values)) {
        values = setDescription(values, value, allOptionsByParameter, paramName, 'scriptLoader');

        if (!values['uid'] && window.uid) {
            values['uid'] = window.uid;
        }
    }

    return JSON.stringify(values, null, 2);
}

function errorShield(scriptPath, param) {
    const badValues = ['undefined', 'NaN', 'Infinity', '-Infinity', null, undefined, ''];
    if (scriptPath.includes("DOPLATA_RABAT")) {
        return { 'DOPLATA-RABAT': t('order.according_to_price') };
    }
    if (scriptPath.includes("DOPLATA-")) {
        return { 'DOPLATA': t('order.according_to_price') };
    }
    if (scriptPath.includes('DOPLATA_EL')) {
        return { 'DOPLATA_EL': t('order.according_to_price') };
    }
    if (scriptPath.includes("CENA_RABAT")) {
        return { 'CENA_RABAT': t('order.according_to_price') };
    }
    if (scriptPath.includes("DOPLATA_EL_RABAT")) {
        return { 'DOPLATA_EL_RABAT': t('order.according_to_price') };
    }
    if (scriptPath.includes("CENA-")) {
        return { 'CENA': t('order.according_to_price') };
    }
    else {
        return { [param.NAME]: t('order.according_to_price') };

    }

}

function roundPrices(pricesObject) {

    if (!pricesObject || typeof pricesObject !== 'object') {
        return pricesObject;
    }

    const rounded = {};
    for (const [key, value] of Object.entries(pricesObject)) {
        if (!isNaN(value) && value !== null && value !== '') {

            const floatValue = parseFloat(value);
            rounded[key] = Math.round(floatValue * 100) / 100;
        } else {

            rounded[key] = value;
        }
    }
    return rounded;
}
