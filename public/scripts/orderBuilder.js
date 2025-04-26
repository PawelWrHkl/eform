export function buildOrderItemStructure(
	order = 0,
	listPrice = {},
	discountPercentage = 0,
	discount = 0,
	unitPrice = 0,
	totalPrice = 0,
    name,
	commission,
	jsonValues ,
    jsonValuesToDisplay,
	amount,
    comment
) {
    let body = {}
    body['order']= order;
    body['listPrice']= listPrice;
    body['discountPercentage'] = discountPercentage;
    body['discount']= discount;
    body['unitPrice']=unitPrice;
    body['totalPrice']=totalPrice;
    body['name']=name;
    body['commission']=commission;
    body['jsonValues']=jsonValues;
    body['jsonValuesToDisplay']= jsonValuesToDisplay;
    body['amount']=amount;
    body['comment']= comment;
    console.log(body);
    return body;
}

