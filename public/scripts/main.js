import {
		 generateForm,
		 buildCommentSpace,
		 buildMainSelect
 } from "/scripts/form.js";
import { 
		resetSelectValues,
		processCommissionInput,
		checkFlags 
	} from "/scripts/formTools/formTools.js";
import {buildOrderItemStructure} from '/scripts/orderBuilder.js'
import { showToast } from "/scripts/components/toast.js";
import { set } from "lodash";

async function loadJsonConfig() {
	const data = await fetch("/config/files.json");
	const departments = await data.json();
	const formContainer = document.getElementById("dynamic-form");
	const {asortmentGroupSelect, departmentSelect} = buildMainSelect(departments);
	const buttonsDiv = document.getElementById("buttons-space");
	const showButton = document.getElementById('show-button');
	let resetButton = document.getElementById('reset-button');

	buttonsDiv.appendChild(resetButton);
	buttonsDiv.appendChild(showButton);

	asortmentGroupSelect.addEventListener("input", async function () {
		let selectedDepartment = departments[departmentSelect.value]
		let selectedGroupId = selectedDepartment[asortmentGroupSelect.value];
		const hiddenClass = document.querySelector('.order-reminder');

		hiddenClass.style.setProperty('display', 'block', 'important');
		let filesToGenerate = {
			params: selectedGroupId.params,
			paramdict: selectedGroupId.paramdict
		  };

		try{
		const [inputs, values, valuesToDisplay] = await generateForm(filesToGenerate);
		 const orderId = document.getElementById('orderId').textContent;
		 const comment = buildCommentSpace(formContainer);

		showButton.onclick = async function () {
			if(!errorHandler()){
				return;
			}
			const result = sendData(inputs,values,valuesToDisplay,orderId,comment);

		};

		resetButton.onclick = function () {
			showToast('info', 'Loading form...');
			resetSelectValues( [Object.keys(values),valuesToDisplay], inputs, values);
			console.log(valuesToDisplay)
		};
	}
	catch (err) {
		console.error("NIE MA PLIKÓW", err);
	    formContainer.innerHTML = "";
		const alertBox = document.getElementById("file-error-message");
		alertBox.textContent = "Nie udało się załadować plików dla wybranej grupy.";
		alertBox.classList.remove("d-none");
		setTimeout(() => alertBox.classList.add("d-none"), 6000);
	  }
	});
	
}

async function errorHandler(){
			const correctFlag = await checkFlags();
			if (typeof checkFlags() !== 'boolean'){
				for (let {key, value} of correctFlag) {
					console.log(key, value);
					let elem = document.getElementById(key);
					if (elem) {
						elem.classList.add('flash-error');
						setTimeout(() => {
							elem.classList.remove('flash-error');
						}, 2000);
					}
				}
				console.log(correctFlag);
				console.log('nie wszystkie flagi ok');
				return false;
			}
}
function prepareForm(){
}

async function sendData(inputs,values,valuesToDisplay,orderId,comment){
	const commission = document.querySelector('.commission-space h5').innerHTML;
	const jsonValuesToDisplay = JSON.stringify(Array.from(valuesToDisplay.entries()));
	
	let postBody = buildOrderItemStructure(
		parseInt(orderId)
		,{},0,0,0,0,
		commission,
		commission,
		values,
		jsonValuesToDisplay,
		1,
		comment.value
	);
	let json = JSON.stringify(postBody);
	try {
		const response = await fetch("/position/save", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: json,
		});
		const result = await response.json();
		setTimeout(() => {}, 3000);// MUSISZ SIE DOWIEDZIEC CZEMU BLAD WYSKAKUJE
		window.location.href =`/orders/order/${orderId}`

	} catch (error) {
		console.error("Bład przy wysyłaniu", error);
	}
	return result;
}


let saveCommisionButton = document.getElementById('commision-save-btn');
	saveCommisionButton.addEventListener('click', function(){
	processCommissionInput();
	loadJsonConfig();
})

document.addEventListener('click', function (e) {
	if (e.target.classList.contains('diag-image')) {
		const dialog = document.getElementById('image-preview-dialog');
		const previewImage = document.getElementById('preview-image');
		previewImage.src = e.target.src;
		dialog.showModal();
	}
});

document.getElementById("close-dialog-btn").addEventListener('click', function () {
	this.parentElement.close();
});

document.getElementById("dialog-close").addEventListener('click', function () {
	document.getElementById('color-dialog').close();
});

