import { showToast } from "./components/toast.js";


async function prepareRestData() {
	
		const orderCommision = document.getElementById("commission-input").value;
		const comment = document.getElementById('comment').value;
		const orderContactInfo = {
			'phone':document.getElementById('phone').value,
			'email':document.getElementById('email').value,
			'street': document.getElementById("street").value,
			'city': document.getElementById("city").value,
			'zip': document.getElementById("zip").value,
			'country': document.getElementById("country").value,
			
		}
		let body = JSON.stringify({
			commission:orderCommision,
			orderContactInfo:orderContactInfo,
			comment: comment
		})		
		return body;
}


async function createOrder(){
	const requestBody = await prepareRestData();
	console.log(prepareRestData)
	try{
		const response = await fetch("/orders/save-order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: requestBody,
		});
		const result = await response.json();
		console.log(response)
		if (result.redirect){
			showToast('success', 'Pomyślnie zapisano dane');
			setTimeout(() => {
                window.location.href = result.redirect;
            }, 3000);
			
		}
	}
		
	catch (error){
		console.error(error);
	}
}
async function updateOrder(orderId){
		const requestBody = await prepareRestData();
		console.log(requestBody)
		try{
			const response = await fetch(`/orders/update-order/${orderId}`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: requestBody,
			});
			const result = await response.json();
			console.log(response)
			if (result.redirect){
				alert('Pomyślnie zapisano dane');
				window.location.href = result.redirect;
			}
		}	
		catch (error){
			console.error(error);
		}
}

const updateOrderButton = document.getElementById('update-order');
const newOrderButton = document.getElementById("save-order-btn");

if (updateOrderButton){
	const orderId = updateOrderButton.dataset.id;
	updateOrderButton.addEventListener('click',() => updateOrder(orderId))
}

else if (newOrderButton){
	newOrderButton.addEventListener('click', () => createOrder())
}

