const mysql = require("mysql2/promise");
const dateUtils = require("../utils/humanize_date.js")

async function connetToDb() {
	const connection = await mysql.createConnection({
		host: process.env.DATABASE_HOST,
		port: process.env.DATABASE_PORT,
		user: process.env.DATABASE_USER,
		password: process.env.DATABASE_PASSWORD,
		database: process.env.DATABASE,
	});
	return connection;
}

async function selectQuery(query,data) {
    const connection = await connetToDb();
    await connection.connect();
    try {
        const [rows, fields] = await connection.query(query, [data]);
        if (rows.length > 0) {
            await connection.end();
            return rows;
        } else {
            await connection.end();
            return false;
        }
    } catch (err) {
        await connection.end();
        console.error(err);
        return false;
    }
}

async function insertQuery(query,data){
    const connection = await connetToDb();
    await connection.connect();
    try{
        const response = await connection.query(query, [data])
        return response;
    }
    
    catch(err){
        await connection.end();
        console.error(err);
        return false;
    }
}
async function updateQuery(query,data){
    const connection = await connetToDb();
    await connection.connect();
    try{
        const response = await connection.query(query, data)
        return response;
    }
    
    catch(err){
        await connection.end();
        console.error(err);
        return false;
    }
}

async function deleteQuery(query,data) {
    const connection = await connetToDb();
    await connection.connect();
    try{
    const [response] = await connection.query(query, [data])
    
    console.log('deleted ' + response.affectedRows + ' rows');
    if (response.affectedRows){
        return true
    }
    else{return false};
}
    catch(err){
        console.log(err)
    };
}

async function insertNewForm(formData){
    const insertFormQuery = 'INSERT INTO order_item(order_id, name, commision, json_parameters, json_parameters_desc, amount, list_price, discount_percentage, discount, unit_price, total_price,comment) values(?)'
    console.log('siema')
    const fields = [
        formData.order,
        formData.name,
        formData.commission,
        JSON.stringify(formData.jsonValues),
        JSON.stringify(formData.jsonValuesToDisplay),
        formData.amount,
        JSON.stringify(formData.listPrice),
        formData.discountPercentage,
        formData.discount,
        formData.unitPrice,
        formData.totalPrice,
        formData.comment
    ];
    
    const response = await insertQuery(insertFormQuery,fields);

    return response;

}

async function getOrderWithItems(orderId){
    
    const orderItemsQuery = 'SELECT * FROM order_item WHERE order_id LIKE ?';
    const orderItems = await selectQuery(orderItemsQuery, orderId);

    const orderDetailsQuery = 'SELECT * FROM \`order\` WHERE id LIKE ?';
    let orderDetails = await selectQuery(orderDetailsQuery, orderId);
    orderDetails = dateUtils.humanizeData(orderDetails);

    return {orderDetails, orderItems}
}

async function getPosition(positionId){
    const query = 'SELECT * FROM order_item WHERE id LIKE ?'
    let result = await selectQuery(query,positionId)
    return result[0];
}

async function getOrderDetails(orderId){
    const orderDetailsQuery = `SELECT 
    \`order\`.id,
    \`order\`.commision,
    \`order\`.created_date,
    \`order\`.comment,
    order_address.id as address_id,
    order_address.street,
    order_address.phone,
    order_address.email,
    order_address.city,
    order_address.zip,
    order_address.country
    FROM \`order\`
    JOIN order_address ON \`order\`.order_address_id = order_address.id
    WHERE \`order\`.id = ?`;
    
    let orderDetails = await selectQuery(orderDetailsQuery, orderId);
    orderDetails = dateUtils.humanizeData(orderDetails);
    return orderDetails[0];
}

async function updateOrderDetails(orderId, commission,contactInfo){
    const query = `
    UPDATE \`order\`
    JOIN order_address ON \`order\`.order_address_id = order_address.id
    SET 
        \`order\`.commision = ?,
        order_address.street = ?,
        order_address.phone = ?,
        order_address.email = ?,
        order_address.city = ?,
        order_address.zip = ?,
        order_address.country = ?
    WHERE \`order\`.id = ?
  `;

  const values = [
    commission,
    contactInfo.street,
    contactInfo.phone,
    contactInfo.email,
    contactInfo.city,
    contactInfo.zip,
    contactInfo.country,
    orderId
]
    const response = updateQuery(query, values);
    return response
}

async function deleteOrder(orderId){
    const query = "DELETE FROM \`order\` WHERE id like ?";
    const response = await deleteQuery(query,orderId);
    return response;
}

async function deletePosition(positionId){
    const query = "DELETE FROM order_item WHERE id like ?";
    const response = await deleteQuery(query,positionId);
    return response;
}



async function getDbPassword(pin) {
    const connection = await connetToDb();
    await connection.connect();

    const query = `SELECT password FROM user WHERE pin LIKE ?`;
 
    try {
        const [rows, fields] = await connection.query(query, [pin]);
        console.log(rows)
        if (rows.length > 0) {
            await connection.end();
            return rows[0].password;
        } else {
            await connection.end();
            return false;
        }
    } catch (err) {
        await connection.end();
        console.error(err);
        return false;
    }
}

async function getUserData(pin){
    const connection = await connetToDb();
    await connection.connect();

	const query = `SELECT * FROM user WHERE pin LIKE ?`;

	try{
	 const [rows, fields] = await connection.query(query, [pin])
     console.log(rows)
	 return rows[0];
	}
	catch(err){
		await connection.end();
		console.error(err);
		return false;
	}
}


async function getUserOrders(userId){
    const connection = await connetToDb();
    await connection.connect();

	const query = `SELECT * FROM \`order\` WHERE user_id LIKE ? order by id desc`;

	try{
	 const [rows, fields] = await connection.query(query, [userId])
     console.log(rows)
     const result = dateUtils.humanizeData(rows);
     return result;
	}
	catch(err){
		await connection.end();
		console.error(err);
		return false;
	}
}

async function insertOrderAddress(address){
    const connection = await connetToDb();
    await connection.connect();

    const query = `INSERT INTO order_address(street,city,zip,country,phone,email) values (?,?,?,?,?,?)`
    try{
        const response = await connection.query(query,
                                                     [address['street'],
                                                     address['city'],
                                                     address['zip'],
                                                     address['country'],
                                                    address['phone'],
                                                      address['email']])
        return response;
    }
    
    catch(err){
        await connection.end();
        console.error(err);
        return false;
    }
}

async function insertNewOrder(commision,addressId,userId,comment, totalPrice=0,organizationId=null){
        const connection = await connetToDb();
        await connection.connect();
    
        const query = `INSERT INTO \`order\` (user_id,order_address_id,commision,total_price,organization_id,comment) values (?,?,?,?,?,?)`
        try{
            const response = await connection.query(query,[userId,
                                                            addressId,
                                                            commision,
                                                            totalPrice,
                                                            organizationId, comment])
            return response;
        }
        
        catch(err){
            await connection.end();
            console.error(err);
            return false;
        }
}

async function updateOrderComment(orderId, comment){
    const connection = await connetToDb();
    await connection.connect();

    const query = `UPDATE \`order\` SET comment = ? where id = ?`
    try{
        const response = await connection.query(query, [comment, orderId])
        return response;
    }

    catch(err){
        await connection.end();
        console.error(err);
        return false;
    }
}

module.exports = { 
    getDbPassword,
    connetToDb,
    getUserData,
    insertOrderAddress,
    insertNewOrder,
    getUserOrders,
    getOrderDetails,
    updateOrderDetails,
    insertNewForm,
    deleteOrder,
    deletePosition,
    getOrderWithItems,
    getPosition,
    updateOrderComment 
};
