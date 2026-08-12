const bcrypt = require('bcryptjs');
const db = require('../db/db_helper.js');
const { usersPath } = require('../config.js');
const path = require('path');
const csv = require('csvtojson');
const { log } = require('../utils/logging');
const { isLocallyManagedPassword } = require('../utils/localPassword');

async function updateClients() {
  if (process.env?.PRODUCTION === 'true' || process.env?.PRODUCTION) {
    await fixEncodingInDatabase();
  }
  const contractorsFileName = 'contractors.txt';
  const contractorsPath = path.join(usersPath, contractorsFileName);


  const fileClientsObjRaw = await csv({ delimiter: '\t' }).fromFile(contractorsPath);


  const fileClientsObj = parseClients(fileClientsObjRaw);

  const dbClientsObj = await db.getUsers();

  const diff = compareClients(fileClientsObj, dbClientsObj);

  if (Object.keys(diff.toAdd).length === 0) {
    log('Baza klientów aktualna');
  } else {
    await insertClients(diff.toAdd);
  }

  if (diff.toUpdate && diff.toUpdate.length > 0) {

    await updateExistingClients(diff.toUpdate);
  } else {
  }


  if (diff.toRemove.length > 0) {

    await deleteNonExistingClients(diff.toRemove);
  } else {
  }


  // if (false) {
  // log('Rozpoczynam aktualizację haseł...');
  // let updated = 0;
  // let skipped = 0;
  // 
  // for (const client of diff.fileClients) {
  // if (client.password) {
  // const user = dbClientsObj.find(dbClient => dbClient.ident === client.ident);
  // if (user) {
  // try {
  // await db.updatePlain(user.ident, client.password);
  // updated++;
  // log(`[${updated}] Zaktualizowano hasło dla użytkownika ${client.ident}`);
  // } catch (err) {
  // log(`Błąd przy aktualizacji hasła dla ${client.ident}:`, err.message);
  // }
  // } else {
  // skipped++;
  // }
  // } else {
  // skipped++;
  // }
  // }
  // 
  // log(`Zakończono aktualizację haseł. Zaktualizowano: ${updated}, Pominięto: ${skipped}`);
  // }
}

function getClientKey(client) {
  const pinPart = (client.pin || '').toUpperCase();
  const identPart = (client.ident || '').toUpperCase();
  return `${pinPart}|${identPart}`;
}



function compareClients(fileClients, dbClients) {

  const pinsInDb = new Set(dbClients.map(c => (c.pin || '').toUpperCase()));
  const identsInDb = new Set(dbClients.map(c => (c.ident || '').toUpperCase()));

  const toAdd = fileClients.filter(client => {
    const pin = (client.pin || '').toUpperCase();
    const ident = (client.ident || '').toUpperCase();
    return !pinsInDb.has(pin) && !identsInDb.has(ident);
  });

  const pinsInFile = new Set(fileClients.map(c => (c.pin || '').toUpperCase()));
  const identsInFile = new Set(fileClients.map(c => (c.ident || '').toUpperCase()));

  const toRemove = dbClients.filter(client => {
    const pin = (client.pin || '').toUpperCase();
    const ident = (client.ident || '').toUpperCase();
    return !pinsInFile.has(pin) && !identsInFile.has(ident);
  });

  const toUpdate = [];
  const fieldsToCheck = ['name', 'address', 'city', 'zip', 'taxid', 'phone', 'kraj', 'password'];

  for (const fileClient of fileClients) {
    const pin = (fileClient.pin || '').toUpperCase();
    const ident = (fileClient.ident || '').toUpperCase();

    const dbClient = dbClients.find(c =>
      (c.pin || '').toUpperCase() === pin && (c.ident || '').toUpperCase() === ident
    );

    if (dbClient) {
      let needsUpdate = false;
      const changes = {};

      for (const field of fieldsToCheck) {
        const fileValue = (fileClient[field] || '').trim();
        const dbValue = (dbClient[field] || '').trim();

        // ⚠️ Hasło ustawione WEWNĄTRZ aplikacji (panel /admin/users, zakładanie
        // konta) leży w bazie jako hash bcrypt, a w contractors.txt jest jawny
        // tekst z ERP — te wartości NIGDY nie będą równe, więc bez tej zapory
        // każde wejście na stronę logowania (tam odpala się `updateClients`)
        // przywracało hasło z pliku i zmiana z panelu żyłaby kilka minut.
        // Zasada: hash w bazie = hasło zarządzane lokalnie, plik go nie rusza.
        if (field === 'password' && isLocallyManagedPassword(dbValue)) {
          continue;
        }

        if (fileValue !== dbValue) {
          needsUpdate = true;
          changes[field] = fileValue;
        }
      }

      if (needsUpdate) {
        toUpdate.push({
          pin: fileClient.pin,
          ident: fileClient.ident,
          changes
        });
      }
    }
  }

  return { toAdd, toRemove, toUpdate, fileClients };
}


/**
 * Refreshes a single user's `country` from contractors.txt's "kraj" column.
 * Called on every client login (see services/authService.js) instead of
 * waiting for the periodic full updateClients() sync, since country drives
 * language detection elsewhere (e.g. userResolver.js during order import) and
 * should stay current per-user without needing a full contractors.txt sync.
 *
 * @param {string} pin
 */
async function syncUserCountry(pin) {
  if (!pin) return;
  try {
    const contractorsFileName = 'contractors.txt';
    const contractorsPath = path.join(usersPath, contractorsFileName);
    const fileClientsObjRaw = await csv({ delimiter: '\t' }).fromFile(contractorsPath);
    const fileClientsObj = parseClients(fileClientsObjRaw);

    const fileClient = fileClientsObj.find(c => (c.pin || '').toUpperCase() === String(pin).toUpperCase());
    if (!fileClient) return;

    const fileCountry = (fileClient.kraj || '').trim();
    if (!fileCountry) return;

    const result = await db.selectQuery('SELECT country FROM `user` WHERE pin = ?', pin);
    const dbCountry = (result[0]?.country || '').trim();

    if (fileCountry.toLowerCase() !== dbCountry.toLowerCase()) {
      await db.updateQuery('UPDATE eform.`user` SET country = ? WHERE pin = ?', [fileCountry, pin]);
      log(`Zaktualizowano kraj dla PIN ${pin}: "${dbCountry}" -> "${fileCountry}"`);
    }
  } catch (err) {
    log(`Błąd przy synchronizacji kraju dla PIN ${pin}:`, err.message);
  }
}

function parseClients(inputArray) {
  const orgMap = {
    COZY: 1,
    FENIX: 2,
    HKL: 3,
    LUXAN_EWA_KRAWCZYK: 4,
    LUXANGMBH: 5,
    LUXANDE: 6,
  };

  const result = inputArray.map(obj => {

    const lowerObj = {};
    for (const key in obj) {
      lowerObj[key.toLowerCase()] = obj[key];
    }

    let owner = (lowerObj.owner || '').toUpperCase().replace(/\s+/g, '_');
    lowerObj.organization_id = orgMap[owner] || 3;

    delete lowerObj.owner;
    return lowerObj;
  });

  return result;
}

async function insertClients(clientsObj) {
  for (const client of clientsObj) {
    try {
      await db.insertUserIntousrtble(client.ident, client.pin, client.password);
      const newUserId = await db.addUser(client);
    } catch (err) {
      log(`Błąd przy dodawaniu ${client.ident}:`, err.message);
    }
  }
}

async function updateExistingClients(clientsToUpdate) {
  const fieldMapping = {
    name: 'client_name',
    address: 'street',
    city: 'city',
    zip: 'zip',
    taxid: 'tax_id',
    phone: 'phone',
    kraj: 'country',
    password: 'password',
  };

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const clientUpdate of clientsToUpdate) {
    try {
      const { pin, ident, changes } = clientUpdate;
      const updateFields = [];
      const updateValues = [];

      for (const [fileField, dbValue] of Object.entries(changes)) {
        const dbField = fieldMapping[fileField];
        if (dbField) {
          updateFields.push(`\`${dbField}\` = ?`);
          updateValues.push(dbValue);
        }
      }

      if (updateFields.length === 0) {
        skipped++;
        continue;
      }

      updateValues.push(pin);
      const sql = `UPDATE eform.\`user\` SET ${updateFields.join(', ')} WHERE pin = ?`;

      await db.updateQuery(sql, updateValues);

      if (changes.password) {
        await db.updatePasswordInUsrtblpsswd(ident, changes.password);
      }

      updated++;
    } catch (err) {
      failed++;
      log(`Błąd przy aktualizacji klienta ${clientUpdate.ident} (PIN: ${clientUpdate.pin}):`, err.message);
    }
  }
}

async function deleteNonExistingClients(clientsToDelete) {
  const excludedPins = new Set(['0000', 'admin', '000000', 'biuro']);

  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  for (const client of clientsToDelete) {
    const pin = (client.pin || '').toLowerCase();

    if (excludedPins.has(pin)) {
      skipped++;
      continue;
    }

    try {
      if (client.pin) {
        await new Promise(resolve => setTimeout(resolve, 100));

        await db.deleteUserByPin(client.pin);
        deleted++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      log(`Błąd przy usuwaniu klienta ${client.ident} (PIN: ${client.pin}):`, err.message);
    }
  }


}

async function fixEncodingInDatabase() {


  const users = await db.getUsers();
  let fixed = 0;
  let skipped = 0;

  for (const user of users) {
    let needsUpdate = false;
    const updates = {};

    const fieldsToCheck = ['name', 'address', 'city', 'ident'];

    for (const field of fieldsToCheck) {
      if (user[field]) {
        let fixedValue = user[field];
        const originalValue = fixedValue;

        if (fixedValue.includes('�')) {

          try {
            const bytes = [];
            for (let i = 0; i < fixedValue.length; i++) {
              bytes.push(fixedValue.charCodeAt(i));
            }

            const problematicIndexes = [];
            for (let i = 0; i < bytes.length; i++) {
              if (bytes[i] === 65533) {
                problematicIndexes.push(i);
              }
            }

            if (problematicIndexes.length > 0) {

              const chars = fixedValue.split('');
              for (const idx of problematicIndexes) {
                const before = idx > 0 ? chars[idx - 1].toLowerCase() : '';
                const after = idx < chars.length - 1 ? chars[idx + 1].toLowerCase() : '';

                if (['h', 'r', 's', 'l', 'n'].includes(before)) {
                  chars[idx] = 'ü';
                } else if (before === 'h' && after === 'h') {
                  chars[idx] = 'ö';
                } else if (['b', 'k', 't', 'd', 'g'].includes(before)) {
                  chars[idx] = 'ö';
                } else {
                  chars[idx] = 'ü';
                }
              }
              fixedValue = chars.join('');

            }
          } catch (err) {
            log(`  Błąd dekodowania:`, err.message);
          }
        }

        const encodingMap = {
          'Ã¶': 'ö', 'Ã¼': 'ü', 'Ã¤': 'ä',
          'Ã–': 'Ö', 'Ãœ': 'Ü', 'Ã„': 'Ä',
          'ÃŸ': 'ß', 'Ã©': 'é', 'Ã¨': 'è',
          'Ã¡': 'á', 'Ã ': 'à'
        };

        for (const [broken, correct] of Object.entries(encodingMap)) {
          if (fixedValue.includes(broken)) {
            fixedValue = fixedValue.replace(new RegExp(broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), correct);

          }
        }

        if (fixedValue !== originalValue) {
          log(`  RÓŻNICA! Original: "${originalValue}" -> Fixed: "${fixedValue}"`);
          updates[field] = fixedValue;
          needsUpdate = true;
        }
      }
    }
    if (needsUpdate && user.id) {
      try {
        let setClause = Object.keys(updates).map(field => `\`${field}\` = ?`).join(', ');
        const values = Object.values(updates);
        values.push(user.id);
        if (setClause == 'name') { setClause = 'client_name' };
        const sql = `UPDATE eform.\`user\` SET ${setClause} WHERE id = ?`;


        const result = await updateQuery(sql, values);

        fixed++;
      } catch (err) {
        log(`Błąd przy aktualizacji użytkownika ID ${user.id}:`, err.message);
        log(`  Stack:`, err.stack);
      }
    } else {
      skipped++;
    }
  }
}
module.exports = { updateClients, fixEncodingInDatabase, updateExistingClients, syncUserCountry, isLocallyManagedPassword };
