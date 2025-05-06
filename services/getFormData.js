const SMB2 = require("smb2");
const fs = require("fs");
const path = require("path");
const util = require("util");
const smbEnumFiles = require('smb-enumerate-files'); 
const { config } = require("dotenv");
const dbHelper = require('../db/db_helper.js');
const { response } = require("express");

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

	// report.files.forEach((file) => {
	// 	console.log(`- ${file.path} (${file.size} B, zmodyfikowano: ${file.mtime})`);
	// });

	try {
		const report = getLocalDirectoryReport(CONFIG.localRoot);

		await syncDirectory(smb2Client, CONFIG.remoteRoot, CONFIG.localRoot);
		const reportAfter = getLocalDirectoryReport(CONFIG.localRoot);
		console.log(typeof report.files, typeof reportAfter)
		for(let i = 0; i<report.length;i++){
			console.log("old: " ,report[i].mtime, 'new: ', reportAfter[i].mtime)
		}
	
		console.log("zakończono.");
	} catch (err) {
		console.error("Błąd :", err);
	} finally {
		await disconnectSMB(smb2Client).catch((e) =>
			console.error("Błąd:", e)
		);
	}
}





function connectSMB() {
    return new SMB2({
        share: CONFIG.host,
        domain: "",
        username: CONFIG.username,
        password: CONFIG.password,
        stats: true
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

async function testMeta() {
    try {
        const files = await smbEnumFiles.enumerate({
            host: "192.168.0.1",
            username: CONFIG.username,
            password: CONFIG.password,
            share: 'shared',
            path: "eform/v",
        });
        const txtFiles = [];
        for (let file of files) {
            if (file.filename.endsWith('txt')) {
                file = {
                    filename: file.filename,
                    size: file.size,
                    modified: file.modified
                }
                txtFiles.push(file);
            }
        }
        return txtFiles;
    } catch (err) {
        console.log(err);
        return [];
    }
}

function areFileListsEqual(listA, listB) {
    if (listA.length !== listB.length) return false;
    const sortByName = arr => arr.slice().sort((a, b) => a.filename.localeCompare(b.filename));
    const aSorted = sortByName(listA);
    const bSorted = sortByName(listB);
    for (let i = 0; i < aSorted.length; i++) {
        const a = aSorted[i], b = bSorted[i];
        if (
            a.filename !== b.filename ||
            a.size !== b.size ||
            a.modified !== b.modified
        ) {
            return false;
        }
    }
    return true;
}

async function controlVersion() {
    const txtFiles = await testMeta();

    // Jeśli masz bazę, pobierz wersję, jeśli nie - możesz pominąć
    // let latestVersion = await dbHelper.getFormVersion('71');
    // latestVersion = latestVersion.ver;
    // let [major, minor, patch] = latestVersion.split('.');
    // patch = parseInt(patch);

    const smb2Client = connectSMB();

    try {
        let directory = path.join(CONFIG.remoteRoot, 'version_control.txt');
        const readFile = util.promisify(smb2Client.readFile.bind(smb2Client));
        let x;
        try {
            x = await readFile(directory);
        } catch (e) {
            x = null;
        }
		let oldFiles;
		if (x && x.length > 0) {
			try {
				oldFiles = JSON.parse(x.toString());
			} catch (e) {
				console.error('Błąd parsowania version_control.txt:', e);
				oldFiles = [];
			}
		} else {
			oldFiles = [];
		}
        if (!areFileListsEqual(txtFiles, oldFiles)) {
            // znajdź pierwszy różniący się plik
            const diffFile = txtFiles.find(fileA =>
                !oldFiles.some(fileB =>
                    fileA.filename === fileB.filename &&
                    fileA.size === fileB.size &&
                    fileA.modified === fileB.modified
                )
            );
            if (diffFile) {
                const versionDir = path.posix.join(CONFIG.remoteRoot, 'versions', diffFile.filename.slice(0, 2));
                const mkdir = util.promisify(smb2Client.mkdir.bind(smb2Client));
                try {
					console.log('tutej')
                    await mkdir(versionDir);
                    console.log('Utworzono katalog:', versionDir);
                } catch (e) {
                    if (e.code === 'STATUS_OBJECT_NAME_COLLISION') {
                        console.log('Katalog już istnieje:');
                    } else {
                        throw e;
                    }
                }
            }
            // Nadpisz plik version_control.txt nową listą plików
            const writeFile = util.promisify(smb2Client.writeFile.bind(smb2Client));
            await writeFile(directory, JSON.stringify(txtFiles, null, 2));
            console.log('Zaktualizowano version_control.txt');
        } else {
            console.log('Brak zmian w plikach.');
        }
    } catch (e) {
        console.error(e);
    } finally {
        await disconnectSMB(smb2Client).catch((e) =>
            console.error("Błąd:", e)
        );
    }
}

controlVersion();



module.exports = { syncFromSMB };
