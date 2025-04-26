const db = require("../db/db_helper.js");
const bcrypt = require("bcryptjs");


async function checkPassword(pin, password) {
	const dbPassword = await db.getDbPassword(pin);
    if (dbPassword) {
		console.log(pin,password)
        return bcrypt.compareSync(password, dbPassword);
	} else {
		console.log("Nie ma takiego użytkownika");
		return false;
	}
}

module.exports = {checkPassword};
