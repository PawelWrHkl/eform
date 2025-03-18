// dataLoader.js
export async function loadData(file) {
	console.log("Wczytywanie pliku:", file);

	try {
		const response = await fetch(file);
		if (!response.ok) throw new Error("Błąd ładowania- " + response.status);
		const text = await response.text();
		const rows = text.split("\n");

		let data = [];
		for (let i = 0; i < rows.length; i++) {
			data.push(rows[i].split("\t"));
		}

		return data;
	} catch (error) {
		console.error("Błąd ładowania-", error);
		return null;
	}
}

export async function parseData(files) {
	const paramsData = await loadData(`./data/${files["params"]}`);
	const dictData = await loadData(`./data/${files["paramdict"]}`);

	if (!paramsData || !dictData) {
		console.error("Nie udało się wczytać CSV");
		return null;
	}

	console.log("CSV przetworzone");
	return {
		params: convertDataToObjects(paramsData),
		dictValues: convertDataToObjects(dictData),
	};
}

export function convertDataToObjects(csvData) {
	let headers = csvData[0];

	for (let header_idx = 0; header_idx < headers.length; header_idx++) {
		headers[header_idx] = headers[header_idx].replace(/\r/g, "");
	}

	let objects = [];

	for (let row = 1; row < csvData.length; row++) {
		let obj = {};

		for (let col = 0; col < headers.length; col++) {
			obj[headers[col]] = csvData[row][col] ? csvData[row][col] : null;
			if (obj.hasOwnProperty("RELATED") && obj.RELATED != null) {
				obj.RELATED = obj.RELATED.replace(/\r/g, "");
			}
		}
		objects.push(obj);
	}

	return objects;
}

export function convertDictValues(dictData) {
	let resultList = {};

	if (!dictData || dictData.length === 0) {
		console.warn("Brak danych w słowniku");
		return resultList;
	}

	for (let i = 0; i < dictData.length; i++) {
		let row = dictData[i];

		for (let key in row) {
			if (row.hasOwnProperty(key)) {
				if (!key.endsWith("_VALUE")) {
					continue;
				}

				let paramName = key.replace("_VALUE", "");
				let value = row[key];
				let description = row[paramName + "_DESCRIPTION"];

				if (value === "<NULL>") {
					value = null;
				}

				if (description === "<NULL>") {
					description = null;
				}

				if (value === null && description === null) {
					continue;
				}

				let enable = row[paramName + "_ENABLE"];
				let active = row[paramName + "_ACTIVE"];
				let graphics = row[paramName + "_GRAPHICS"];

				if (enable === "<NULL>") {
					enable = null;
				}

				if (active === "<NULL>") {
					active = null;
				}

				if (graphics === "<NULL>") {
					graphics = null;
				}

				let result = {
					ROW_NUM: row["ROW_NUM"],
					VALUE: value,
					DESCRIPTION: description,
					ENABLE: enable,
					ACTIVE: active,
					GRAPHICS: graphics,
				};
				if (!resultList[paramName]) {
					resultList[paramName] = [];
				}
				resultList[paramName].push(result);
			}
		}
	}
	// console.log(resultList);
	return resultList;
}
