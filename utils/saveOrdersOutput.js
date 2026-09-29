const path = require('path');
const fs = require('fs');
const {
    fileExists,
    readFileContent,
    readFileBinary,
    removeFile,
    saveFile } = require('./fileManager');
const ownerService = require('../services/owner.js');
const { outputData, shortJsonDir } = require('../config')
const { buildOrderFileName } = require('./orderFileName');
const db = require("../db/db_helper.js");
const { read } = require('pdfkit');
const { at, forEach } = require('lodash');

function normalizeUploadedFileName(originalName) {
    if (typeof originalName !== 'string' || !originalName) {
        return '';
    }

    const hasMojibake = /[ÃÂÅÄÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß]/.test(originalName) || originalName.includes('�');
    const decodedCandidate = Buffer.from(originalName, 'latin1').toString('utf8');

    if (hasMojibake && !decodedCandidate.includes('�')) {
        return decodedCandidate.normalize('NFC');
    }

    return originalName.normalize('NFC');
}

class ordersManager {
    constructor() {
        this.data = '';
        this.userIdent = '';
        this.groupNumber = '';
        this.orgIdent = '';
        this.output_path = '';
        this.fileName = '';
        this.orderId = '';
        this.orderpos = '';
        this.orderNo = '';
        this.sendFileName = '';
    }

    setOutputPath(req, orderId, orderNo, orderpos, overrides = {}) {
        if (overrides.orgIdent && overrides.userIdent) {
            this.userIdent = overrides.userIdent;
            this.orgIdent = overrides.orgIdent;
        } else {
            this.user = ownerService.getCurrentUser(req);
            this.userIdent = this.user ? this.user.ident : 'unknown_user';
            this.orgIdent = this.user ? this.user.organization : 'unknown_org';
        }
        this.orderId = orderId || 'unknown_order';
        this.orderNo = orderNo || 'unknown_orderNo';
        this.orderpos = orderpos || 'unknown_pos';
        this.output_path = outputData;
        this.fileNameSuffix = overrides.fileNameSuffix || '';
    }

    async mkDir() {
        try {
            await fs.promises.mkdir(this.output_path, { recursive: true });
        } catch (err) {
            console.error(`Failed to create directory: ${err.message}`);
        }
    }

    async saveAttachments(files, posId) {
        this.posId = posId;
        let attachments = [];
        for (const file of files) {
            console.log(file);
            const safeOriginalName = normalizeUploadedFileName(file.originalname);
            const extension = path.extname(safeOriginalName);
            const baseName = safeOriginalName;
            const fileName = `${this.posId}_${file.fieldname}_${baseName}`;
            this.sendFilename = `${this.orgIdent}_${this.userIdent}_${this.orderNo}_${this.orderpos}_${file.fieldname}${extension}`;
            const fullpath = path.join(this.output_path, fileName);
            const saveResult = await saveFile(fullpath, file.buffer);
            if (!saveResult) {
                console.error(`Failed to save attachment: ${fileName}`);
            }
            else {
                console.log(`Attachment saved: ${saveResult}`);
                attachments.push({ savedName: saveResult, baseName: safeOriginalName });
            }
        }
        await db.updateAttachments(this.posId, attachments);

    }

    async updateAttachments(files, posId) {
        this.posId = posId;
        let attachments = await db.getAttachments(posId) || [];
        const filesToDelete = [];
        let hasChanges = false;

        for (const file of files) {
            console.log(file);
            const safeOriginalName = normalizeUploadedFileName(file.originalname);
            const extension = path.extname(safeOriginalName);
            const baseName = safeOriginalName;
            const fileName = `${this.posId}_${file.fieldname}_${baseName}`;

            const existingIndex = attachments.findIndex((att) =>
                typeof att?.savedName === 'string' && att.savedName.startsWith(`${this.posId}_${file.fieldname}_`)
            );

            if (existingIndex !== -1 && attachments[existingIndex]?.savedName === fileName) {
                console.log(`Plik ${fileName} już istnieje, pomijam zapis.`);
                continue;
            }

            const fullpath = path.join(this.output_path, fileName);
            const saveResult = await saveFile(fullpath, file.buffer);
            if (!saveResult) {
                console.error(`Failed to save attachment: ${fileName}`);
            }
            else {
                console.log(`Attachment saved: ${saveResult}`);
                hasChanges = true;

                if (existingIndex !== -1) {
                    const oldSavedName = attachments[existingIndex]?.savedName;
                    if (oldSavedName && oldSavedName !== saveResult) {
                        filesToDelete.push(oldSavedName);
                    }
                    attachments[existingIndex] = { savedName: saveResult, baseName: safeOriginalName };
                } else {
                    attachments.push({ savedName: saveResult, baseName: safeOriginalName });
                }
            }
        }

        if (!hasChanges) {
            return;
        }

        await db.updateAttachments(this.posId, attachments);

        for (const oldSavedName of filesToDelete) {
            const filePath = path.join(this.output_path, oldSavedName);
            if (await fileExists(filePath)) {
                try {
                    await fs.promises.unlink(filePath);
                    console.log(`Deleted old attachment: ${oldSavedName}`);
                } catch (error) {
                    console.error(`Error deleting attachment ${oldSavedName}:`, error);
                }
            }
        }
    }

    async readAttachments(posId) {
        try {
            const attachmentsList = await db.getAttachments(posId || this.posId);
            if (!attachmentsList || attachmentsList.length === 0) {
                console.warn(`No attachments found for posId: ${posId}`);
                return {};
            }

            const attachments = {};
            for (const attachment of attachmentsList) {
                const filePath = path.join(this.output_path, attachment.savedName);
                if (await fileExists(filePath)) {
                    try {
                        const fileData = await readFileBinary(filePath);
                        attachments[attachment.baseName] = fileData;
                        console.log(`Reading attachment: ${attachment.baseName}`);
                    } catch (error) {
                        console.error(`Error reading attachment ${attachment.baseName}:`, error);
                    }
                } else {
                    console.warn(`Attachment file not found: ${attachment.baseName} at path ${filePath}`);
                }
            }
            return attachments;
        } catch (error) {
            console.error(`Error in readAttachments: ${error.message}`);
            return {};
        }

    }

    async setJsonFileName(orderPos, posId, suffix = '') {
        if (orderPos || posId) {
            if (posId) {
                this.posId = posId;
            }
            await this.changeAttachmentFileNames(orderPos, posId);
        }
        this.fileName = buildOrderFileName(this.orgIdent, this.userIdent, this.orderNo, suffix);

        this.fullPath = `${this.output_path}/${this.fileName}.json`;
        console.log('JSON file name set to:', this.fullPath);


        return { fileName: this.fileName, fullPath: this.fullPath };
    }

    async changeAttachmentFileNames(orderPos, posId) {
        const targetPosId = posId || this.posId;
        const targetOrderPos = orderPos || this.orderpos;
        if (!targetPosId || !targetOrderPos) {
            console.warn('Missing posId/orderPos for attachment rename. Skipping.');
            return [];
        }
        const attachmentsList = await db.getAttachments(targetPosId) || [];
        if (attachmentsList.length === 0) {
            return [];
        }

        const renamedAttachments = [];
        const ftpAttachmentNames = [];
        let hasChanges = false;

        for (const attachment of attachmentsList) {
            const currentSavedName = attachment?.savedName;
            const currentBaseName = attachment?.baseName;

            if (!currentSavedName) {
                continue;
            }

            const sourcePath = path.join(this.output_path, currentSavedName);
            if (!(await fileExists(sourcePath))) {
                console.warn(`Attachment file not found for rename: ${sourcePath}`);
                renamedAttachments.push(attachment);
                continue;
            }

            const fieldMatch = currentSavedName.match(/(ZALACZNIK_\d+)/i) || (currentBaseName || '').match(/(ZALACZNIK_\d+)/i);
            const fieldName = fieldMatch ? fieldMatch[1].toUpperCase() : 'unknown_field';
            const extension = path.extname(currentSavedName) || path.extname(currentBaseName || '');
            const targetSavedName = `${this.orgIdent}_${this.userIdent}_${this.orderNo}_${targetOrderPos}_${fieldName}${extension}`;

            ftpAttachmentNames.push(targetSavedName);

            if (targetSavedName === currentSavedName) {
                renamedAttachments.push(attachment);
                continue;
            }

            const fileData = await readFileBinary(sourcePath);
            const targetPath = path.join(this.output_path, targetSavedName);
            const saveResult = await saveFile(targetPath, fileData);

            if (!saveResult) {
                console.error(`Failed to save renamed attachment: ${targetSavedName}`);
                renamedAttachments.push(attachment);
                continue;
            }

            await removeFile(sourcePath);
            hasChanges = true;
            renamedAttachments.push({
                savedName: targetSavedName,
                baseName: currentBaseName
            });
            console.log(`Renamed attachment saved: ${targetSavedName}`);
        }

        if (hasChanges) {
            await db.updateAttachments(targetPosId, renamedAttachments);
        }

        return ftpAttachmentNames;
    }
}


module.exports = { ordersManager };