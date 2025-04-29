const SMB2 = require("smb2");
const fs = require("fs");
const path = require("path");
const util = require("util");

const CONFIG = {
	host: "\\\\192.168.101.1\\shared",
	username: "nobody",
	password: "nobody",
	remoteRoot: "eform/data",
	localRoot: path.join(__dirname, "../public/data"),
};

function connectSMB() {
	return new SMB2({
		share: CONFIG.host,
		domain: "",
		username: CONFIG.username,
		password: CONFIG.password,
	});
}

function disconnectSMB(client) {
	return new Promise((resolve, reject) => {
		client.close((err) => {
			if (err) return reject(err);
			resolve();
		});
	});
}

function ensureLocalDirectoryExists(localPath) {
	if (!fs.existsSync(localPath)) {
		fs.mkdirSync(localPath, { recursive: true });
	}
}

function shouldDownloadFile(localPath, remoteData) {
	const isTxtFile = localPath.toLowerCase().endsWith(".txt");

	if (isTxtFile) {

		return true;
	}

	if (!fs.existsSync(localPath)) return true;

	const localSize = fs.statSync(localPath).size;
	return remoteData.length !== localSize;
}

async function readRemoteDirectory(client, remotePath) {
	const readdir = util.promisify(client.readdir.bind(client));
	return await readdir(remotePath);
}

async function readRemoteFile(client, remoteFilePath, retries = 5, delay = 200) {
	const readFile = util.promisify(client.readFile.bind(client));
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			return await readFile(remoteFilePath);
		} catch (err) {
			if (err.code === "STATUS_PENDING") {
				await new Promise((res) => setTimeout(res, delay));
			} else {
				throw err;
			}
		}
	}
	return await readFile(remoteFilePath);
}

// 🔍 Obliczanie rozmiaru katalogu (rekurencyjnie)
async function calculateRemoteDirectorySize(client, remoteDir) {
	let size = 0;

	try {
		const entries = await readRemoteDirectory(client, remoteDir);
		for (const entry of entries) {
			const entryPath = path.posix.join(remoteDir, entry);
			try {
				const data = await readRemoteFile(client, entryPath);
				size += data.length;
			} catch (err) {
				if (isDirectoryError(err)) {
					size += await calculateRemoteDirectorySize(client, entryPath);
				}
			}
		}
	} catch (err) {
		console.warn(`Błąd przy obliczaniu rozmiaru katalogu ${remoteDir}:`, err);
	}

	return size;
}

function calculateLocalDirectorySize(localDir) {
	let size = 0;
	if (!fs.existsSync(localDir)) return 0;

	const entries = fs.readdirSync(localDir);
	for (const entry of entries) {
		const entryPath = path.join(localDir, entry);
		const stats = fs.statSync(entryPath);
		if (stats.isDirectory()) {
			size += calculateLocalDirectorySize(entryPath);
		} else {
			size += stats.size;
		}
	}
	return size;
}

function isDirectoryError(err) {
	return (
		err.code === "STATUS_ACCESS_DENIED" ||
		err.code === "EISDIR" ||
		err.message.includes("EISDIR") ||
		err.message.includes("Illegal operation on a directory")
	);
}


function removeLocalEntry(entryPath) {
	if (!fs.existsSync(entryPath)) return;

	const stat = fs.statSync(entryPath);
	if (stat.isDirectory()) {
		fs.readdirSync(entryPath).forEach((child) => {
			removeLocalEntry(path.join(entryPath, child));
		});
		fs.rmdirSync(entryPath);
	} else {
		fs.unlinkSync(entryPath);
	}
}
async function syncDirectory(client, remoteDir, localDir) {
	ensureLocalDirectoryExists(localDir);

	let remoteEntries;
	try {
		remoteEntries = await readRemoteDirectory(client, remoteDir);
	} catch (err) {
		console.error(`Błąd ${remoteDir}:`, err);
		return;
	}

	const remoteNamesSet = new Set(remoteEntries);

	if (fs.existsSync(localDir)) {
		const localEntries = fs.readdirSync(localDir);
		for (const localEntry of localEntries) {
			if (!remoteNamesSet.has(localEntry)) {
				const localEntryPath = path.join(localDir, localEntry);
				removeLocalEntry(localEntryPath);
				console.log(`Usunięto ${localEntryPath}`);
			}
		}
	}

	for (const entry of remoteEntries) {
		const remotePath = path.posix.join(remoteDir, entry);
		const localPath = path.join(localDir, entry);

		try {
			const isRemoteDirectory = await isRemoteDir(client, remotePath);

			if (isRemoteDirectory) {
				await syncDirectory(client, remotePath, localPath);
			} else {
				const fileData = await readRemoteFile(client, remotePath);
				if (shouldDownloadFile(localPath, fileData)) {
					fs.writeFileSync(localPath, fileData);
					console.log(`Pobrano: ${remotePath}`);
				} 
			}
		} catch (err) {
			console.error(`Błąd ${remotePath}:`, err.message);
		}
	}
}
function getLocalDirectoryReport(baseDir) {
	const result = {
		totalSize: 0,
		files: [],
	};

	function walk(dir, relativePath = "") {
		if (!fs.existsSync(dir)) return;

		const entries = fs.readdirSync(dir);
		for (const entry of entries) {
			const fullPath = path.join(dir, entry);
			const relPath = path.join(relativePath, entry);
			const stats = fs.statSync(fullPath);

			if (stats.isDirectory()) {
				walk(fullPath, relPath);
			} else {
				result.totalSize += stats.size;
				result.files.push({
					path: relPath,
					size: stats.size,
					mtime: stats.mtime,
				});
			}
		}
	}

	walk(baseDir);
	return result;
}

async function isRemoteDir(client, remotePath) {
	try {
		const files = await readRemoteDirectory(client, remotePath);
		return Array.isArray(files);
	} catch (err) {
		if (
			err.code === "STATUS_ACCESS_DENIED" ||
			err.message.includes("Not a directory") ||
			err.message.includes("STATUS_NOT_A_DIRECTORY")
		) {
			return false;
		}
		throw err;
	}
}

async function syncFromSMB() {
	const smb2Client = connectSMB();
	const report = getLocalDirectoryReport(CONFIG.localRoot);
	// report.files.forEach((file) => {
	// 	console.log(`- ${file.path} (${file.size} B, zmodyfikowano: ${file.mtime})`);
	// });

	try {
		await syncDirectory(smb2Client, CONFIG.remoteRoot, CONFIG.localRoot);
		console.log("zakończono.");
	} catch (err) {
		console.error("Błąd :", err);
	} finally {
		await disconnectSMB(smb2Client).catch((e) =>
			console.error("Błąd:", e)
		);
	}
}




module.exports = { syncFromSMB };
