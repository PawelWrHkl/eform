import { generateForm } from "./form.js";
import { resetSelectValues, saveOrderPositionToJson } from "./formTools.js";

async function loadJsonConfig() {
	const data = await fetch("./data/files.json");
	const files = await data.json();
	console.log("siema");

	const asortmentGroupSelect = document.getElementById("asortment-group");
	const buttonsDiv = document.getElementById("buttons-space");

	const showButton = createButton("Pokaz wartości", "form-button");
	let resetButton = createButton("Resetuj pola", "form-button");

	buttonsDiv.appendChild(resetButton);
	buttonsDiv.appendChild(showButton);

	asortmentGroupSelect.addEventListener("input", async function () {
		let selectedValue = asortmentGroupSelect.value;

		const [inputs, values] = await generateForm(files[selectedValue]);

		showButton.onclick = function () {
			console.log("Aktualne wartości pól:", values);
			alert(JSON.stringify(values, null, 2));
			saveOrderPositionToJson(values, "1.json");
		};

		resetButton.onclick = function () {
			resetSelectValues(Object.keys(values), inputs, values);
		};
	});
}

function createButton(text, className, destinationDivName) {
	let button = document.createElement("button");
	button.textContent = text;
	button.type = "button";
	button.setAttribute("class", className);

	return button;
}
loadJsonConfig();
