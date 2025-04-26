import { parseData, convertDictValues } from "./formTools/dataLoader.js";
import {
	getPossibleValues,
	createInputField,
	validateFormInput,
	updateFieldInputs,
	updateFieldStates,
	resetDependences,
	buildValuesToDisplay,
} from "./formTools/formTools.js";

export async function generateForm(
	files,
	values = {}
	
) {
	window.inputsValidatiors = {};
	window.inputFlags = {};
	window.tempGroupNumber = files.params.substring(0,2);
	const data = await parseData(files);

	window.params = data.params;
	window.actualParam = '';
	window.actualValue = '';
	const dictValues = data.dictValues;
	if (!data) return;
	let labelNumber = 1;
	const inputs = {};
	let displayValues = new Map();
	let options = {};
	let allOptionsByParameter = convertDictValues(dictValues);
	const form = document.getElementById("dynamic-form");
	form.innerHTML = "";


	for (let i = 0; i < params.length; i++) {
		let param = params[i];
		options = getPossibleValues(allOptionsByParameter[param.NAME]);
		await buildHtml(options, param);
	}

	async function buildHtml(options, param) {

		const paramName = param.NAME;
		let div = document.createElement("div");
		div.classList.add(`${param.NAME}-select-area`);
		let label = document.createElement("label");
		if (!paramName || paramName.startsWith("_") || !param.DESCRIPTION) return;
		label.textContent = `${String(labelNumber)}. ${param.DESCRIPTION}: `;

		let input = await createInputField(param, options, tempGroupNumber);

		input.name = param.NAME;
		input.id = param.NAME;
		inputs[param.NAME] = input;
		displayValues.set(param.NAME, { 'param_description':param.DESCRIPTION });
		values[param.NAME] = "";

		form.appendChild(div);
		div.appendChild(label);
		div.appendChild(input);
		div.appendChild(document.createElement("br"));

		labelNumber++;
		if (input.tagName === "INPUT") {
			inputFlags[paramName] = true;
	}}

	for (let key in inputs) {
		
		inputs[key].addEventListener("input", function () {
			if (this.tagName === "INPUT"){
				values[this.name] = parseFloat(this.value);
			}

			resetDependences([params,displayValues], this.name, inputs, values);
			buildValuesToDisplay(allOptionsByParameter, this.value, this.name, displayValues, this.tagName);
		});
		
		if (inputs[key].tagName === "INPUT") {

			inputs[key].addEventListener('blur', function() {
				updateFieldInputs(params, inputs, allOptionsByParameter, values, options, this.name, this.value, this.tagName, displayValues);
				validateFormInput(values, this);
				buildValuesToDisplay(allOptionsByParameter, this.value, this.name, displayValues, this.tagName);
				updateFieldStates(params, inputs, values);
			});
		} else {
			inputs[key].addEventListener('change', function() {

				updateFieldInputs(params, inputs, allOptionsByParameter, values, options, this.name, this.value, this.tagName, displayValues);
				updateFieldStates(params, inputs, values);
			});
		}
	

		document.getElementById('dialog-confirm').onclick = () => {
			const activeBox = document.querySelector('.image-box.active');
			if (!activeBox) return;
	
			const selectedValue = activeBox.querySelector('.image-name').dataset.value;
			let paramName = activeBox.dataset.paramName;
			let paramDescription = activeBox.dataset.paramDescription;
			values[paramName] = selectedValue;
			let currentInput = inputs[paramName];
	
			if (currentInput && currentInput.tagName === "BUTTON") {
				currentInput.innerText = `${selectedValue} - ${paramDescription}`;
				currentInput.value = selectedValue;
			}

			buildValuesToDisplay(allOptionsByParameter, selectedValue, paramName, displayValues, 'BUTTON');
			
			resetDependences([params,displayValues], paramName, inputs, values);
			updateFieldInputs(params, inputs, allOptionsByParameter, values,options, paramName,selectedValue,'BUTTON', displayValues);
			updateFieldStates(params, inputs, values);
			document.getElementById("color-dialog").close();
		};
	
	


	}

	return [inputs, values, displayValues];
}
