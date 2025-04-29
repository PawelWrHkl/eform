const parser = new window.formulaParser.Parser();
let error_count = 0;
let success_count = 0;


function zaw(params){
	if (!params || params.length < 2) return false;
    console.log(co,lista)
    let co = (params[0] || "").toString();
    let lista = (params[1] || "").toString();
    co = "," + co + ",";
    lista = "," + lista + ",";

    return lista.includes(co);
}

function zaw2(params){
    if (!params || params.length < 4) return false;
    let co1 = (params[0] || "").toString();
    let lista1 = (params[1] || "").toString();
    let co2 = (params[2] || "").toString();
    let lista2 = (params[3] || "").toString();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";

    return lista1.includes(co1) && lista2.includes(co2);
}
function zaw3(params){
	if (!params || params.length < 6) return false;

    let co1 = (params[0] || "").toString();
    let lista1 = (params[1] || "").toString();
    let co2 = (params[2] || "").toString();
    let lista2 = (params[3] || "").toString();
    let co3 = (params[4] || "").toString();
    let lista3 = (params[5] || "").toString();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";
    co3 = "," + co3 + ",";
    lista3 = "," + lista3 + ",";

    return lista1.includes(co1) && lista2.includes(co2) && lista3.includes(co3);
}

parser.setFunction("ZAW", function (params) {
    return zaw(params);
});

parser.setFunction("ZAWIERA", function (params) {
    return zaw(params);
});


parser.setFunction("ZAW2", function (params) {
	return zaw2(params);
});

parser.setFunction("ZAW3", function (params) {
	return zaw3(params);
});

parser.setFunction("NIEZAW", function (params) {
    return !zaw(params);
});

parser.setFunction("NIEZAW2", function (params) {
    return !zaw2(params);
});
parser.setFunction("NIEZAW3", function (params) {
    return !zaw3(params);
});


parser.setFunction("ZAWNIEZAW", function (params) {
    if (!params || params.length < 4) return false;

    let co1 = (params[0] || "").toString();
    let lista1 = (params[1] || "").toString();
    let co2 = (params[2] || "").toString();
    let lista2 = (params[3] || "").toString();

    co1 = "," + co1 + ",";
    lista1 = "," + lista1 + ",";
    co2 = "," + co2 + ",";
    lista2 = "," + lista2 + ",";

    return lista1.includes(co1) && !lista2.includes(co2);
});

parser.setFunction("ORAZ", function (params) {
	if (!params || params.length === 0) return false;
	return params.every(value => !!value);
});

parser.setFunction("USTAW", function (params) {

    if (!params || params.length < 3) {
        return false;
    }

    const pole = String(params[0]).toUpperCase();
    const parametr = String(params[1]).toUpperCase();
    const wartosc = params[2];
    const validatorModel = inputsValidatiors[actualParam][actualValue]
	const aktualnaWartosc = parser.getVariable(pole) || window.formulaContext[pole];
    console.log(pole,parametr,wartosc,validatorModel,aktualnaWartosc,'formula')
	if (!validatorModel[pole]) {
		validatorModel[pole] = {};
	}
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


function evaluateFormula(expression, context) {

	if (!expression || expression === "<NULL>") {
		return true;
	}

	try {
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
        if (expression.includes("ZAWIERA(MODEL,AO10")) {
            console.log('expression', expression, result,context)

        }
		if (result.result == "0") {
			result.result = false;
		}
		if (result.error) {
			error_count++;
			return false;
		} else {
			success_count++;
			return !!result.result;
		}
	} catch (error) {
		console.error("Błąd parsowania: " + expression, error);
		return false;
	}
}

window.FormulaHandler = { evaluateFormula }


