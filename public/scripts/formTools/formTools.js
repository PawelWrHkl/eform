import {
	processCommissionInput,
	getPossibleValues,
	createInputField,
	saveOrderPositionToJson
 } from './createForm.js';

import {
	resetDependences,
	resetSelectValues,
	resetDisplayEntry,
	buildValuesToDisplay,
	updateFieldInputs,
	updateFieldStates,
	checkRelated,
	} from './updateFieldsAndValues.js';

import {
	getProcedures,
	setDefaultValues,
	checkFlags,
	validateFormInput
} from './validateUtils.js';

import {createDialog,getInfoFromDialog,

} from './dialogUtils.js';

export function logFunctionName(functionName){
	const sep = '-'.repeat(10)
	console.log(`${sep} ${functionName} ${sep}`)
}

export {
	processCommissionInput,
	getPossibleValues,
	createInputField,
	saveOrderPositionToJson,
	resetDependences,
	resetSelectValues,
	resetDisplayEntry,
	buildValuesToDisplay,
	updateFieldInputs,
	updateFieldStates,
	checkRelated,
	getProcedures,
	setDefaultValues,
	checkFlags,
	validateFormInput,
	createDialog,
	getInfoFromDialog
}