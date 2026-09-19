const path = require('path');
const { outputData, shortJsonDir } = require('../config')
const fs = require('fs');
const { slopePhotoPath } = require('../config');
const { KeyObject } = require('crypto');
const { ordersManager } = require('../utils/saveOrdersOutput');
const { log } = require('../utils/logging');
const { formatClientLabel } = require('../utils/formatClient');
const { getProductionSendSkipClient, isProductionVersion, shouldForceProductionSend } = require('../utils/productionSendGuard');
const { resolveItemClientDiscount } = require('./subPrices');
// `order_item.prod_days` bywa stringiem (sterownik MySQL potrafi zwrócić INT
// jako tekst), a odbiorca JSON-a oczekuje liczby albo `null` — nie "12".
function normalizeProdDays(value) {
    if (value == null || value === '') return null;
    const dni = Number(value);
    return Number.isFinite(dni) ? dni : null;
}

class OrderSender {

    constructor(req, order, orderItems, options = {}) {
        this.options = options;
        this.orderItems = orderItems;
        this.slopePaths = [];
        this.shortItems = [];
        this.attachmentsList = [];
        this.orderPositions = [];
        this.data = {
            orderno: order?.order_idx ?? 0,
            orderid: order?.id ?? 0,
            commission: order?.commision ?? "",
            client: formatClientLabel(order.client_name, order.user_ident),
            organizationIdent: order.org_ident,
            userIdent: order.user_ident,
            created_date: order.created_date,
            tax: order.tax_id,
            comment: order.comment,
            sentDate: order.sent_date,
            name: order.name,
            address: order.street,
            zip: order.zip,
            city: order.city,
            country: order.country,
            email: order.email,
            phone: order.phone,
            // Stały adres klienta (zawsze z tabeli `user`) — niezależny od adresu dostawy
            userStreet: order.user_street || '',
            userZip: order.user_zip || '',
            userCity: order.user_city || '',
            userCountry: order.user_country || '',
            userPhone: order.user_phone || '',
            total: order.total_price,
            total_hidden: order.total_price_hidden,
            items: []

        }
        let idx = 1;
        for (let item of orderItems) {
            this.attachSlopePhoto(item, idx);


            const rawObj = item.json_parameters;

            const sortedFilteredObj = Object.keys(rawObj)
                .sort()
                .reduce((acc, key) => {
                    acc[key] = rawObj[key];
                    return acc;
                }, {});


            // Rabat eForma (rabat klienta + 1% za korzystanie z serwisu) — klucz
            // pojawia się TYLKO wtedy, gdy pozycja go ma, żeby nie zaśmiecać
            // JSON-a zerami u wszystkich pozostałych klientów. Sam rabat jest
            // już wliczony w ceny w `parameters`; to informacja dla odbiorcy,
            // skąd wzięła się różnica wobec cennika.
            const eforRabat = resolveItemClientDiscount(item);

            this.data.items.push({
                posid: item?.id ?? 0,
                orderpos: idx,
                product: item?.asortment_group_number,
                department: item?.department ?? '',
                product_description: item?.group_name ?? '',
                commission: item?.commision ?? "",
                ...(eforRabat ? { efor_rabat: eforRabat.percent } : {}),
                // Szacowany termin produkcji POZYCJI (dni) — dokładnie ta sama
                // liczba, którą klient widzi w wierszu „Termin produkcji" pod
                // pozycją. Źródłem jest kolumna `order_item.prod_days`, liczona
                // i zapisywana przez `services/productionDays.js`
                // (`recalcAndSaveMaxProdDays`) — wysyłka jej NIE przelicza, żeby
                // FTP dostał to samo, co było na ekranie. `null` = brak czasu
                // dla grupy asortymentowej.
                prod_days: normalizeProdDays(item?.prod_days),
                parameters: sortedFilteredObj,
                comment: item.comment,
                asortment: item.asrotment_group_number,
                link_group: item?.link_group ?? null
            })

            this.shortItems.push({
                posid: item?.id ?? 0,
                orderpos: idx,
                product: item?.asortment_group_number,
                product_description: item?.group_name ?? '',
                commission: item?.commision ?? "",
                parameters_short: item.parameters_short
            })
            this.orderPositions.push({
                posId: item?.id ?? null,
                orderPos: item?.orderpos ?? idx
            });
            idx++;
        }
        this.ordersManagerInstance = new ordersManager();
        const pathOverrides = {
            orgIdent: options.orgIdent || order.org_ident,
            userIdent: options.userIdent || order.user_ident,
            fileNameSuffix: options.fileNameSuffix || ''
        };
        this.ordersManagerInstance.setOutputPath(req, this.data.orderid, this.data.orderno, undefined, pathOverrides);
    }

    async init() {

        for (const position of this.orderPositions) {
            let positionAttachments = await this.ordersManagerInstance.changeAttachmentFileNames(position.orderPos, position.posId);
            for (let positionAttachment of positionAttachments) {
                this.attachmentsList.push(positionAttachment);
            }
        }
        const suffix = this.options.fileNameSuffix || '';
        const result = await this.ordersManagerInstance.setJsonFileName(undefined, undefined, suffix);
        this.fileName = result.fileName;
        this.fullPath = result.fullPath;


        return this.data
    }

    getData() {
        return this.data
    }

    async saveToFile(options = {}) {
        try {
            const shortJsonPath = path.join(shortJsonDir, `${process.env.NODE_ENV}_${this.fileName}`);
            await fs.promises.mkdir(path.dirname(shortJsonPath), { recursive: true });
            await fs.promises.writeFile(shortJsonPath, JSON.stringify(this.shortItems, null, 2), 'utf-8');
        }
        catch (err) {
            log(`Failed to save short JSON file: ${err.message}`);
        }

        const ignoredProductionClient = getProductionSendSkipClient(this.data, [], options);
        if (ignoredProductionClient) {
            log(`Pominięto wysyłkę FTP dla klienta z ignore_mail_list.json: ${ignoredProductionClient}`);
            return;
        }

        const useProductionFtp = isProductionVersion() || shouldForceProductionSend(options.forceProductionSend);

        if (!useProductionFtp) {
            const filePath = this.fullPath;

            try {
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                await fs.promises.writeFile(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
                log(`File saved successfully: ${filePath}`);
            } catch (error) {
                log(`Failed to save file: ${error.message}`);
            }
        }
        else {
            const ftp = require('basic-ftp');
            const client = new ftp.Client();
            client.ftp.verbose = true;
            const ftpConfig = {
                host: process.env.FTP_HOST,
                user: process.env.FTP_USER,
                password: process.env.FTP_PASSWORD,
                secure: false,
                remotePath: `/orders-out/${this.fileName}.json`
            };
            const filePath = this.fullPath;

            try {
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
                await fs.promises.writeFile(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
                await client.access({
                    host: ftpConfig.host,
                    user: ftpConfig.user,
                    password: ftpConfig.password,
                    secure: ftpConfig.secure
                });
                log(`Connected to FTP server: ${ftpConfig.host}`);
                const result = await client.uploadFrom(filePath, ftpConfig.remotePath);
                log(`FTP upload result: ${JSON.stringify(result)}`);

                const remoteDir = path.posix.dirname(ftpConfig.remotePath);
                for (const attachment of this.attachmentsList) {
                    if (typeof attachment !== 'string') {
                        continue;
                    }
                    const attachmentPath = path.join(outputData, attachment);
                    const attachmentRemotePath = path.posix.join(remoteDir, attachment);
                    const attachmentResult = await client.uploadFrom(attachmentPath, attachmentRemotePath);
                    log(`FTP upload attachment result: ${JSON.stringify(attachmentResult)}`);
                }

            }
            catch (err) {
                log(`FTP upload failed: ${err.message}`);
            }
            client.close();
        }

    }

    // Admin-only lokalny zapis kopii JSON — bez FTP i bez maila potwierdzenia,
    // pomija też ignore_mail_list.json (tu nie ma żadnej wysyłki do pominięcia).
    async saveJsonOnly() {
        try {
            const shortJsonPath = path.join(shortJsonDir, `${process.env.NODE_ENV}_${this.fileName}`);
            await fs.promises.mkdir(path.dirname(shortJsonPath), { recursive: true });
            await fs.promises.writeFile(shortJsonPath, JSON.stringify(this.shortItems, null, 2), 'utf-8');
        }
        catch (err) {
            log(`Failed to save short JSON file: ${err.message}`);
        }

        const filePath = this.fullPath;
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
        log(`File saved successfully: ${filePath}`);
    }

    attachSlopePhoto(item, idx) {
        const slopeVals = item?.parameters_short?.data?.WYMIAROWANIE_SLOPOW;
        let dimensions = [];

        for (const [key, value] of Object.entries(slopeVals || {})) {
            if (key.endsWith("_VISIBLE") && value == true) {
                let baseKey = key.split('___VISIBLE')[0];
                dimensions.push(
                    { [baseKey.split('_')[1] || baseKey]: slopeVals[baseKey] });
            }
        }

        const slopeType = item?.parameters_short?.data?.WYMIAROWANIE_SLOPOW?.TYP ?? false;
        if (slopeType) {
            const slopePhotoFileName = `${slopeType}.png`;
            const slopePhotoFullPath = path.join(slopePhotoPath, slopePhotoFileName);
            this.slopePaths.push({
                photoPath: slopePhotoFullPath,
                attachmentName: `pos_${idx}_slope.png`,
                dimensions: dimensions
            });
        }

    }
}


module.exports = { OrderSender };