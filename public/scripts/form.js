import { parseData, convertDictValues } from "./dataLoader.js";
import {
	getPossibleValues,
	createInputField,
	checkRelated,
	updateFieldInputs,
	updateFieldStates,
	resetSelectValues,
	resetDependences,
	saveOrderPositionToJson,
} from "./formTools.js";

export async function generateForm(
	files = { params: "71param.txt", paramdict: "71paramdict.txt" }
) {
	const data = await parseData(files);
	// console.log(data);
	if (!data) return;
	console.log(data);
	const params = data.params;
	const dictValues = data.dictValues;
	const form = document.getElementById("dynamic-form");
	form.innerHTML = "";

	let labelNumber = 1;
	const inputs = {};
	let values = {};
	let options = {};

	// ############################################ tu są dobre wartości
	let testValues = convertDictValues(dictValues);

	for (let i = 0; i < params.length; i++) {
		let param = params[i];
		if (param.ACTIVE !== "true") continue;

		options = getPossibleValues(param, testValues[param.NAME], values);
		buildHtml(options, param);
	}

	function buildHtml(options, param) {
		let div = document.createElement("div");
		div.classList.add(`${param.NAME}-select-area`);
		let label = document.createElement("label");
		// label.textContent = `${String(labelNumber)}. ${param.DESCRIPTION} (${param.NAME}): `;
		label.textContent = `${String(labelNumber)}. ${param.DESCRIPTION}: `;

		let input = createInputField(param, options);

		input.name = param.NAME;
		inputs[param.NAME] = input;

		values[param.NAME] = "";

		form.appendChild(div);
		div.appendChild(label);
		div.appendChild(input);
		div.appendChild(document.createElement("br"));
		// console.log(`czy jest related;${param.RELATED}, `)
		labelNumber++;
		// if (param.RELATED) {
		// console.log(param.NAME,param.RELATED)
		// div.hidden = true
		// };
	}

	for (let key in inputs) {
		inputs[key].addEventListener("input", function () {
			values[this.name] = this.value;
			console.log("Zmieniona wartość:", this.name, "=", this.value);
			console.log(this.tagName);
			resetDependences(params, this.name, inputs, values);
			if (this.tagName === "INPUT") {
			} else {
				// console.log(values);
				checkRelated(params, values);
				updateFieldInputs(params, inputs, testValues, values);
				updateFieldStates(params, inputs, values);
			}
		});
	}

	return [inputs, values];
}
