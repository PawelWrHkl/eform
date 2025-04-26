const bcrypt = require("bcryptjs");

const passwords = {
	"1234":false
};
const saltRounds = 10;

const keys = Object.keys(passwords);
const hashPromises = keys.map((key) => {
	return new Promise((resolve, reject) => {
		bcrypt.genSalt(saltRounds, (err, salt) => {
			if (err) return reject(err);
			bcrypt.hash(key, salt, (err, hash) => {
				if (err) return reject(err);
				passwords[key] = hash;
				resolve();
			});
		});
	});
});

Promise.all(hashPromises)
	.then(() => {
		console.log(passwords);
	})
	.catch((err) => console.error(err));
