import { generateForm } from "/scripts/form.js";
import { resetSelectValues,
		 processCommissionInput,
		checkFlags } from "/scripts/formTools/formTools.js";
import {buildOrderItemStructure} from '/scripts/orderBuilder.js'

async function loadJsonConfig() {
	const data = await fetch("/config/files.json");
	const departments = await data.json();

	const formContainer = document.getElementById("dynamic-form");
	const asortmentGroupSelect = document.getElementById("asortment-group-select");
	const departmentSelect = document.getElementById("department-select");

	buildMainSelect(departmentSelect, asortmentGroupSelect, departments);

	const buttonsDiv = document.getElementById("buttons-space");

	const showButton = document.getElementById('show-button');
	let resetButton = document.getElementById('reset-button');

	buttonsDiv.appendChild(resetButton);
	buttonsDiv.appendChild(showButton);

	asortmentGroupSelect.addEventListener("input", async function () {
		let selectedDepartment = departments[departmentSelect.value]
		let selectedGroupId = selectedDepartment[asortmentGroupSelect.value];
		
		console.log(selectedGroupId)
		const hiddenClass = document.querySelector('.order-reminder');
		hiddenClass.style.setProperty('display', 'block', 'important');
		let filesToGenerate = {
			params: selectedGroupId.params,
			paramdict: selectedGroupId.paramdict
		  };
		console.log();
		try{
		const [inputs, values, valuesToDisplay] = await generateForm(filesToGenerate);
		 const orderId = document.getElementById('orderId').textContent;
		 const comment = buildCommentSpace(formContainer);

		showButton.onclick = async function () {
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

			console.log("Aktualne wartości pól:", values);
			console.log(values)
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
				console.log("wysłano do backendu");
				window.location.href =`/orders/order/${orderId}`
			} catch (error) {
				console.error("Bład przy wysyłaniu", error);
			}
		};

		resetButton.onclick = function () {
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

function buildMainSelect(departmentSelect, asortmentGroupSelect, files) {
	
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

function buildCommentSpace(destinationNode) {
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