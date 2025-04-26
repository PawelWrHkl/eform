const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const db = require("../db/db_helper.js");
const orderService = require('../services/orderService.js')
const get_data = require('../services/getFormData.js');

router.get('/edit/:orderId', requireLogin, async (req,res) => {
    console.log(req.params.orderId)
    const orderData = await db.getOrderDetails(req.params.orderId);
    console.log(orderData,'order')
    res.render('edit_order.njk',{
        orderData: orderData})
})


router.get("/", requireLogin, async (req, res) => {
    res.render("orders.njk",{ 
        orders:await db.getUserOrders(user.id)
    });
});


router.get("/add-order",requireLogin, (req, res) => {
	res.render("new-order.njk");
});


router.get('/order/:orderId', requireLogin, async (req, res) => {
    const {orderDetails, orderItems} = await db.getOrderWithItems(req.params.orderId);

    if (orderItems){
    const heads = Object.keys(orderItems[0].json_parameters);
    let cleanOrderItems = await orderService.jsonTextBackToMap(orderItems);
    console.log("SIEMA", cleanOrderItems)
    return res.render('order.njk',
        {orderDetails:orderDetails[0], orderItems:orderItems,heads:heads,cleanOrderItems:cleanOrderItems}
    );}

    else{
        return res.render('order.njk',{orderDetails:orderDetails[0]});
    }
})


router.get("/order/:orderId/new-position/", requireLogin, (req, res) => {

    get_data.syncFromSMB();
    res.render("form.njk",{orderId:req.params.orderId});
});



router.post('/save-order', async (req, res) => {
  try{
      const {commission, orderContactInfo,comment} = req.body;
      const response = await db.insertOrderAddress(orderContactInfo)
      const addrId = response[0].insertId;
      db.insertNewOrder(commission,addrId,user.id, comment);
      
      return res.json({ status: "success", message: "Dane zapisane poprawnie", redirect: "/orders" });
  }
  catch (err){
      console.error(err);
  }
});

router.put('/update-order/:orderId', async (req, res) => {
    try{
        const {commission, orderContactInfo} = req.body;
        const { orderId } = req.params;
        const existingOrder = await db.getOrderDetails(orderId);
        let response = false;
        if (existingOrder){
            response = await db.updateOrderDetails(orderId,commission, orderContactInfo);
        }
        else{
            response = await db.insertOrderAddress(orderContactInfo)
            const addrId = response[0].insertId;
            response = db.insertNewOrder(commission,addrId,user.id);
        }

        return res.json({response:response, redirect: `/orders/order/${orderId}` });
    }
    catch(err){
        console.error(err);
    }
})

  router.delete('/order/:orderId/delete/', async (req,res) =>{
  // console.log(req.params.orderId);
  let response = await db.deleteOrder(req.params.orderId);
    if (response){
        return res.status(200).json({
            success:true,
            message: `Zamówienie nr ${req.params.orderId} usunięte poprawnie`
        });
    }
    else{
        return res.status(400).json({
            success:false,
            message: `Nie znaleziono zamówienia`
        })
    }
  })

  router.patch('/:orderId/comment/update', requireLogin, async (req, res) => {
    const { orderId } = req.params;
    const { comment } = req.body;
  
    try {
      const orderRows = await db.getOrderDetails(orderId);
      if (!orderRows || orderRows.length === 0) {
        return res.status(404).json({ success: false, error: 'Zamówienie nie istnieje.' });
      }
      await db.updateOrderComment(orderId, comment);
  
      return res.json({
        success: true,
        data: { orderId: +orderId, comment }
      });
    } catch (err) {
      console.error('Błąd przy aktualizacji komentarza:', err);
      return res.status(500).json({ success: false, error: 'Wewnętrzny błąd serwera.' });
    }
  });
module.exports = router;
