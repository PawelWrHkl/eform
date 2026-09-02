const userQueries = require('./users');
const orderQueries = require('./orders');
const positionQueries = require('./positions');
const otherQueries = require('./others');
const ownerQueries = require('./owner');
const statusesQueries = require('./statuses');
const addressQueries = require('./address');
const groupQueries = require('./group');
const orgCustomerQueries = require('./orgCustomers');
const rememberTokenQueries = require('./rememberTokens');


module.exports = {
  ...positionQueries,
  ...otherQueries,
  ...userQueries,
  ...orderQueries,
  ...ownerQueries,
  ...statusesQueries,
  ...addressQueries,
  ...groupQueries,
  ...rememberTokenQueries,
  // Moduł „Klienci organizacji" — rozłożony płasko (brak kolizji nazw,
  // sprawdzone) i dodatkowo pod własnym kluczem, żeby wołający mógł wprost
  // pokazać, z której warstwy korzysta: `db.orgCustomers.listCustomers(...)`.
  ...orgCustomerQueries,
  orgCustomers: orgCustomerQueries
};