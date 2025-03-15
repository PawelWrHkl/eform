const parser = new window.formulaParser.Parser();
let error_count = 0;
let success_count = 0;

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

		for (let key in upperCaseContext) {
			if (upperCaseContext.hasOwnProperty(key)) {
				parser.setVariable(key, upperCaseContext[key]);
			}
		}

		// expression = expression.replace(/'/g, '"');
		// expression = expression.replace(/^"|"$/g, '');
		// expression = expression.replace(/""/g, '"');
		expression = expression.toUpperCase();

		let result = parser.parse(expression);
		if (result.result == "0") {
			result.result = false;
		}
		//  console.log(`${expression} \n${Object.values(context)} \n${result.result}  \n ${data_file}`)
		if (result.error) {
			error_count++;
			console.log(`errors:${error_count} ${expression}`);
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

window.FormulaHandler = { evaluateFormula };
