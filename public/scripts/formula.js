const parser = new window.formulaParser.Parser();
let error_count = 0;
let success_count = 0;

// --- FUNKCJE PORÓWNAŃ ---

function wsrod(params) {
    if (!params || params.length < 2) return false;

    let co = (params[0] || "").toString().toLowerCase();
    let lista = (params[1] || "").toString().toLowerCase();

    co = "," + co + ",";
    lista = "," + lista + ",";
    return lista.includes(co);
}

// ZAW2, ZAW3 – wieloelementowe porównania
function wsrod2(params){
    if (!params || params.length < 4) return false;
    let co1 = (params[0] || "").toString().toLowerCase();
    let lista1 = (params[1] || "").toString().toLowerCase();
    let co2 = (params[2] || "").toString().toLowerCase();
    let lista2 = (params[3] || "").toString().toLowerCase();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";

    return lista1.includes(co1) && lista2.includes(co2);
}
function wsrod3(params){
    if (!params || params.length < 6) return false;

    let co1 = (params[0] || "").toString().toLowerCase();
    let lista1 = (params[1] || "").toString().toLowerCase();
    let co2 = (params[2] || "").toString().toLowerCase();
    let lista2 = (params[3] || "").toString().toLowerCase();
    let co3 = (params[4] || "").toString().toLowerCase();
    let lista3 = (params[5] || "").toString().toLowerCase();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";
    co3 = "," + co3 + ",";
    lista3 = "," + lista3 + ",";

    return lista1.includes(co1) && lista2.includes(co2) && lista3.includes(co3);
}


// --- NOWA FUNKCJA ZAWIERA ---
function zawiera(params) {
    // Sprawdza, czy którykolwiek fragment z listy występuje w Co
    if (!params || params.length < 2) return false;
    let co = (params[0] || "").toString();
    let lista = (params[1] || "").toString();
    let arr = lista.split(",");
    for (let i = 0; i < arr.length; i++) {
        let fragment = arr[i].trim();
        if (fragment && co.indexOf(fragment) !== -1) {
            return true;
        }
    }
    return false;
}

// --- REJESTRACJA FUNKCJI ---

parser.setFunction("WSROD", function (params) {
    return wsrod(params);
});
parser.setFunction("NIEWSROD", function (params) {
    return !wsrod(params);
});
parser.setFunction("WSROD2", function (params) {
    return wsrod2(params);
});
parser.setFunction("NIEWSROD2", function (params) {
    return !wsrod2(params);
});
parser.setFunction("WSROD3", function (params) {
    return wsrod3(params);
});
parser.setFunction("NIEWSROD3", function (params) {
    return !wsrod3(params);
});
parser.setFunction("WSRODNIEWSROD", function (params) {
    if (!params || params.length < 4) return false;

    let co1 = (params[0] || "").toString().toLowerCase();
    let lista1 = (params[1] || "").toString().toLowerCase();
    let co2 = (params[2] || "").toString().toLowerCase();
    let lista2 = (params[3] || "").toString().toLowerCase();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";

    return lista1.includes(co1) && !lista2.includes(co2);
});

parser.setFunction("ZAWIERA", function (params) {
    return zawiera(params);
});

// --- POZOSTAŁE FUNKCJE ---

parser.setFunction("ORAZ", function (params) {
    if (!params || params.length === 0) return false;
    return params.every(value => !!value);
});

parser.setFunction("USTAW", function (params) {
    if (!params || params.length < 2) {
        return false;
    }

    const pole = String(params[0]).toUpperCase();
    const parametr = String(params[1]).toUpperCase();
    const wartosc = params.length >= 3 ? params[2] : undefined;
    const validatorModel = inputsValidatiors[actualParam][actualValue];
    const aktualnaWartosc = parser.getVariable(pole) || window.formulaContext[pole];

    if (!validatorModel[pole]) {
        validatorModel[pole] = {};
    }

    if (wartosc === undefined) {
        // Kasowanie ustawienia
        delete validatorModel[pole][parametr];
        if (parametr === "DOM") {
            delete window.formulaContext[pole];
            parser.setVariable(pole, undefined);
        }
        return true;
    } else {
        validatorModel[pole][parametr] = wartosc;

        switch(parametr) {
            case "MIN":
                if (aktualnaWartosc !== undefined && aktualnaWartosc !== null) {
                    return Number(aktualnaWartosc) >= Number(wartosc);
                }
                return false;
            case "MAX":
                if (aktualnaWartosc !== undefined && aktualnaWartosc !== null) {
                    return Number(aktualnaWartosc) <= Number(wartosc);
                }
                return false;
            case "DOM":
                parser.setVariable(pole, wartosc);
                window.formulaContext[pole] = wartosc;
                return true;
            case 'POW': 
            default:
                return false;
        }
    }
});

parser.setFunction("LEFT", function (params) {
    if (typeof params[0] === "string" && typeof params[1] === "number") {
        return params[0].substring(0, params[1]);
    }
    return null;
});

parser.setFunction("RIGHT", function (params) {
    if (typeof params[0] === "string" && typeof params[1] === "number") {
        return params[0].slice(-params[1]);
    }
    return null;
});

parser.setFunction("CEILING", function (params) {
    if (typeof params[0] === "number" && typeof params[1] === "number") {
        return Math.ceil(params[0] / params[1]) * params[1];
    }
    return null;
});

// --- EVALUATEFORMULA ---

function evaluateFormula(expression, context) {
    if (!expression || expression === "<NULL>") {
        return true;
    }

    let upperCaseContext = {};
    if (!context) {
        context = {};
    }

    for (let key in context) {
        if (context.hasOwnProperty(key)) {
            let value = context[key];
            if (typeof value === "string") {
                upperCaseContext[key] = value.toUpperCase();
            } else {
                upperCaseContext[key] = value;
            }
        }
    }

    window.formulaContext = context;
    
    for (let key in upperCaseContext) {
        if (upperCaseContext.hasOwnProperty(key)) {
            parser.setVariable(key, upperCaseContext[key]);
        }
    }

    expression = expression.replace(/^=/, '');
    expression = expression.toUpperCase();

    let result = parser.parse(expression);

    if (result.result == "0") {
        result.result = false;
    }
    if (result.error) {
        error_count++;
        if (error_count <=10){
            console.warn(result.error, error_count, expression)
            throw new Error(`Nieprawidłowa formuła: ${expression}`)
        }
        return false;
    } else {
        success_count++;
        return !!result.result;
    }
}

window.FormulaHandler = { evaluateFormula }
