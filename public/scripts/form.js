import { parseData, convertDictValues } from "./formTools/dataLoader.js";
import {
	getPossibleValues,
	createInputField,
	validateFormInput,
	updateFieldInputs,
	updateFieldStates,
	resetDependences,
	buildValuesToDisplay,
	getInfoFromDialog,
} from "./formTools/formTools.js";
import { showToast } from "./components/toast.js";
export async function generateForm(
	files,
	values = {}
	
) {

	window.inputsValidatiors = {};
	window.inputFlags = {};
	window.tempGroupNumber = files.params.substring(0,2);
	console.log(files,tempGroupNumber);
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

				updateFieldInputs(params, inputs, values, displayValues,allOptionsByParameter, options, this.name, this.value, this.tagName);
				validateFormInput(values, this);
				buildValuesToDisplay(allOptionsByParameter, this.value, this.name, displayValues, this.tagName);
				updateFieldStates(params, inputs, values);
			});
		} else {
			inputs[key].addEventListener('change', function() {

				updateFieldInputs(params, inputs, values, displayValues,allOptionsByParameter, options, this.name, this.value, this.tagName);
				updateFieldStates(params, inputs, values);
			});
		}

		document.getElementById('dialog-confirm').onclick = () => {
			let [selectedValue, paramName] = getInfoFromDialog(values, inputs);

			buildValuesToDisplay(allOptionsByParameter, selectedValue, paramName, displayValues, 'BUTTON');
			resetDependences([params,displayValues], paramName, inputs, values);
			updateFieldInputs(params, inputs,values, displayValues, allOptionsByParameter, options, paramName,selectedValue,'BUTTON');
			updateFieldStates(params, inputs, values);
		};
	}

	return [inputs, values, displayValues];
}


export function buildCommentSpace(destinationNode) {
	const commentDiv = document.createElement('div');
	commentDiv.classList.add('comment-space', 'col-12');
  
	const commentLabel = document.createElement('label');
	commentLabel.setAttribute('for', 'orderComment');
	commentLabel.textContent = 'UWAGI DO ZAMÓWIENIA:';
	commentLabel.classList.add('form-label', 'mb-1');
  
	const comment = document.createElement('textarea');
	comment.id = 'orderComment';
	comment.classList.add('form-control', 'item-comment');
	comment.rows = 4;
  
	commentDiv.appendChild(commentLabel);
	commentDiv.appendChild(comment);
	destinationNode.appendChild(commentDiv);
  
	return comment;
}


export function buildMainSelect(files) {
	const asortmentGroupSelect = document.getElementById("asortment-group-select");
	const departmentSelect = document.getElementById("department-select");
	departmentSelect.innerHTML = `<option value="" disabled selected>Wybierz dział</option>`;
	for (let department of Object.keys(files)) {
	  const option = document.createElement("option");

	  option.value = department;
	  option.textContent = department;
	  departmentSelect.appendChild(option);
	  
	}
  
	departmentSelect.addEventListener("change", () => {
	  const selectedDepartment = departmentSelect.value;
	  const groups = files[selectedDepartment];
  

	  asortmentGroupSelect.innerHTML = `<option value="" disabled selected>Wybierz grupę</option>`;
  

	  for (let [groupKey, groupData] of Object.entries(groups)) {
		const option = document.createElement("option");
		option.value = groupKey;
		option.textContent = groupData.name;
		asortmentGroupSelect.appendChild(option);
	  }
	});
	return {asortmentGroupSelect, departmentSelect};

  }