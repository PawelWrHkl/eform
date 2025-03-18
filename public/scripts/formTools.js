export function getPossibleValues(param, dictValues, values) {
	console.log(param, dictValues, values);
	const possibleElements = [];

	if (!dictValues || dictValues.length === 0) {
		return { possibleElements };
	}

	for (let i = 0; i < dictValues.length; i++) {
		let row = dictValues[i];

		if (row.VALUE == "<NULL>") row.VALUE = null;
		if (row.DESCRIPTION == "<NULL>") row.DESCRIPTION - null;
		let row_number = row.ROW_NUM;
		possibleElements.push(row);
	}

	return { possibleElements };
}

export function createInputField(param, options) {
	options = options.possibleElements;

	if (options.length > 1) {
		let select = document.createElement("select");
		select.classList.add("select");
		select.appendChild(new Option("Wybierz opcję", ""));
		for (let idx = 0; idx < options.length; idx++) {
			let row = options[idx];

			let optionText = `(${row.VALUE}) ${row.DESCRIPTION}`;
			let option = new Option(optionText || row.VALUE, row.VALUE);
			option.id = `${row.ROW_NUM}-${param.NAME}`;

			select.appendChild(option);
		}
		return select;
	}

	let input = document.createElement("input");
	if (param.TYPE === "number") {
		input.type = "number";
	} else {
		input.type = "text";
	}
	return input;
}

export function checkRelated(params, values) {
	let parameters = Object.values(params);
	// console.log(params);
	console.log("checkRelated");

	for (let idx = 0; idx < parameters.length; idx++) {
		let param = parameters[idx];
		let relatedValue = param.RELATED;

		if (relatedValue) {
			if (relatedValue.trim() === "" || relatedValue == null) {
				param.RELATED = false;
			} else {
				param.RELATED = relatedValue;
			}
		} else {
			param.RELATED = false;
		}

		if (param.RELATED) {
			values[param.RELATED] = values[param.NAME];
		}
	}
}

export function updateFieldInputs(params, inputs, testValues, values) {
	console.log("updateFieldInputs:");
	const allowedOptions = {};
	for (const paramName in inputs) {
		allowedOptions[paramName] = new Set();
	}
	// sprawdzenie enable za pomoca formuly
	for (const paramName in testValues) {
		const paramArray = testValues[paramName];

		if (!inputs[paramName]) continue;

		for (const param of paramArray) {
			const isEnabled = window.FormulaHandler.evaluateFormula(
				param.ENABLE,
				values,
				"paramdict"
			);
			// if(paramName == 'TYP')console.log(param.VALUE,param.ENABLE,values,isEnabled);
			if (isEnabled) {
				if (param.ROW_NUM) {
					const idAndValue = `${param.ROW_NUM}-${paramName}`;
					allowedOptions[paramName].add(idAndValue);
				}
				// console.log(paramArray)
			}
		}
	}
	// console.log(allowedOptions)
	// wlaczenie i wylaczenie
	for (const paramName in inputs) {
		let param = params.find((param) => param.NAME === paramName);
		// console.log(allowedOptions)
		const currentSelect = inputs[paramName];
		const allowed = allowedOptions[paramName];

		// console.log(currentSelect,allowed)
		// console.log(allowed.ROW_NUM)
		for (const child of currentSelect.children) {
			const optionValue = child.id.replace(/\s+/g, " ").trim();

			if (!allowed.has(optionValue)) {
				child.disabled = true;
				child.hidden = true;
			} else {
				child.disabled = false;
				child.hidden = false;
			}
		}
		if (param.RELATED) {
			console.log(inputs[param.RELATED]);
			inputs[param.RELATED].parentElement.style.display = "none";
		}
	}
}

export function updateFieldStates(params, inputs, values) {
	console.log("updateFieldStates");

	for (let key in inputs) {
		let param;
		for (let i = 0; i < params.length; i++) {
			if (params[i].NAME === key) {
				param = params[i];

				break;
			}
		}
		if (!param || !param.ENABLE) continue;
		// console.log(param.ENABLE);
		let shouldEnable = window.FormulaHandler.evaluateFormula(
			param.ENABLE,
			values,
			"param"
		);
		// console.log(param.NAME, shouldEnable, 'param')
		//let shouldEnable = window.FormulaHandler.evaluateFormula(param.ENABLE, values);
		// console.log("Sprawdzenie dla:", key, " Wynik:", shouldEnable);
		let paramDiv = inputs[key].parentNode;
		paramDiv.hidden = !shouldEnable;
		let labelText = paramDiv.children[0].innerHTML;

		console.log(labelText.slice(1));
	}
}

export function resetSelectValues(parameters, inputs, values) {
	// Funkcja przyjmuje liste parametrów np.[MODEL,KOLSYST,RELATED] i resetuje przypisane selecty
	for (let idx = 0; idx < parameters.length; idx++) {
		let param = parameters[idx];
		console.log(param, "siema");
		inputs[param].selectedIndex = 0;
		values[param] = "";
	}
}

export function resetDependences(params, name, inputs, values) {
	let param = params.find((obj) => obj.NAME === name);
	if (param && param.DEPENDENCES && typeof param.DEPENDENCES === "string") {
		let paramsToReset = param.DEPENDENCES.split(",");

		resetSelectValues(paramsToReset, inputs, values);
	}
}

export function saveOrderPositionToJson(data, filename) {
	const jsonData = JSON.stringify(data, null, 2);
	const blob = new Blob([jsonData], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
