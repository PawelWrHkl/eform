const { fileExists,
    readFileBinary } = require('../../utils/fileManager');
const path = require('path');
const sharp = require('sharp');
const { log } = require('../../utils/logging');
const { sanitizeFilename } = require('../../utils/sanitizeFilename');

async function addTextOverlayToImage(imageBuffer, dimensions) {
    if (!dimensions) {
        return imageBuffer;
    }

    const textLines = [];
    for (const [key, value] of Object.entries(dimensions)) {
        for (const [subKey, subValue] of Object.entries(value)) {
            textLines.push(`${subKey}: ${subValue}`);
        }
    }

    if (textLines.length === 0) {
        return imageBuffer;
    }


    const text = textLines.join('\n');
    log(text + ' TEXT LINES IN ADD TEXT OVERLAY FUNCTION');

    const svgText = `
        <svg width="400" height="150">
            <rect width="250" height="150" fill="rgba(255, 255, 255, 0)" />
            <text x="20" y="40" font-size="24" fill="black" font-family="Arial" font-weight="bold">
                ${text.split('\n').map((line, i) => `<tspan x="20" dy="${i === 0 ? 0 : 35}">${line}</tspan>`).join('')}
            </text>
        </svg>
        `;

    try {
        const modifiedImage = await sharp(imageBuffer)
            .composite([{
                input: Buffer.from(svgText),
                top: 10,
                left: 10
            }])
            .png()
            .toBuffer();

        return modifiedImage;
    } catch (error) {
        log('Błąd przy nakładaniu tekstu na obraz:', error);
        return imageBuffer;
    }
}

async function getExtraAttachments(attachmentPaths) {
    const attachments = [];

    for (const item of attachmentPaths) {
        const dimensions = item?.dimensions || null;

        const filePath = typeof item === 'string' ? item : item?.photoPath;
        if (!filePath) {
            continue;
        }

        const exists = await fileExists(filePath);
        if (exists) {
            let content = await readFileBinary(filePath);


            if (dimensions) {
                content = await addTextOverlayToImage(content, dimensions);
            }

            const filename = typeof item === 'string'
                ? path.basename(filePath)
                : (item?.attachmentName || path.basename(filePath));

            attachments.push({
                filename: sanitizeFilename(filename),
                content: content
            });
        }
    }

    return attachments;
}

module.exports = { getExtraAttachments };