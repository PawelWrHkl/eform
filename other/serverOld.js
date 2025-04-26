const express = require("express");
const path = require("path");
const nunjucks = require("nunjucks");
const dotenv = require("dotenv").config();
const session = require("express-session");
const app = express();

const db = require("./db/db_helper.js");
const ordersRoutes = require('./routes/orders');
const positionsRoutes = require('./routes/positions');
const userRoutes = require('./routes/users');
const mainRoutes = require('./routes/index');
const { appendFileSync } = require("fs");

//zmienne globalne
let user = {};

// scizki do template
app.use(express.static(path.join(__dirname, "public")));
const templatePath = path.join(__dirname, "templates");

// korzystanie z json
app.use(express.urlencoded({ extended: "false" }));
app.use(express.json());



// konfiguracja nunjucks (silnik do widoków)
nunjucks.configure("templates", {
	autoescape: true,
	express: app,
	noCache: true,
});

const dbConfig = {
	host: process.env.DATABASE_HOST,
	port: process.env.DATABASE_PORT,
	user: process.env.DATABASE_USER,
	password: process.env.DATABASE_PASSWORD,
	database: process.env.DATABASE,
};

//sesja i funkcja, która wywala niezalogowanych
app.use(
	session({
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: true,
		// pamiętaj żeby ustawić secure:false podczas wprowadzania na produkcje
		cookie: { secure: false, maxAge: 9999999999999 },
	})
);





// endpointy 1
// app.get("/", requireLogin, async (req, res)  => {
	// user = await db.getUserData(req.session.user.pin);
	// return res.render("base.njk", { user:user });
	// 
// });
// 
// app.get('/orders/edit/:orderId', async (req,res) => {
	// console.log('siema')
	// const orderData = await db.getOrderDetails(req.params.orderId);
	// res.render('edit_order.njk',{
		// orderData: orderData})
// })
// 
// 
// app.get("/orders", requireLogin, async (req, res) => {
// 
	// res.render("orders.njk",{ 
		// orders:await db.getUserOrders(user.id)
	// });
// });
// 
// app.get("/login", (req, res) => {
	// res.render("login.njk");
// });
// 
// 
// app.get("/add-order", (req, res) => {
// 
	// res.render("new-order.njk");
// });
// 
// app.post("/auth/login", async (req, res, next) => {
    // try {
        // const { pin, password } = req.body;
        // const isValid = await checkPassword(pin, password);
		// console.log(isValid);
        // if (isValid) {
            // req.session.user = { pin, password };
			// get_data.getFormData();
            // return res.redirect("/");
        // } else {
            // return res.render("login.njk", { message: "Dane nieprawidłowe" });
        // }
    // } catch (err) {
        // return next(err);
    // }
// });



// 
// app.post("/logout", (req, res) => {
	// req.session.destroy((err) => {
		// if (err) return res.redirect("/");
		// res.redirect("/login");
	// });
// });
// 
// 
// app.get('/orders/order/:orderId', async (req, res) => {
	// const {orderDetails, orderItems} = await db.getOrderDetails(req.params.orderId);
	// if (orderItems){
	// const heads = Object.keys(orderItems[0].json_parameters);
	// return res.render('order.njk',
		// {orderDetails:orderDetails[0], orderItems:orderItems,heads:heads}
// 
	// );}
	// else{
		// return res.render('order.njk',{orderDetails:orderDetails[0]});
	// }
// })
// 
// app.get("/orders/order/:orderId/new-position/", requireLogin, (req, res) => {
	// res.render("form.njk",{orderId:req.params.orderId});
// });
// 
// app.post('/position/save', async (req, res) => {
	// try {
	//   const formData = req.body;
	//   console.log(formData);
	//   const result = await db.insertNewForm(formData);
	//   console.log(result);
	//   res.json({ status: "success", message: "Dane zapisane poprawnie" });
	// } catch (err) {
	//   return res.status(400).json({ error: "Niepoprawne dane" });
	// }
//   });
// 
// app.post('/api/save-order', async (req, res) => {
	// try{
		// const {commission, orderAddress} = req.body;
		// const response = await db.insertOrderAddress(orderAddress)
		// const addrId = response[0].insertId;
		// db.insertNewOrder(commission,addrId,user.id);
// 
		// return res.json({ status: "success", message: "Dane zapisane poprawnie", redirect: "/orders" });
	// }
	// catch (err){
		// console.error(err);
	// }
// });
// 
// app.delete('/orders/order/:orderId/delete/', async (req,res) =>{
// console.log(req.params.orderId);
// let response = await db.deleteOrder(req.params.orderId);
	// if (response){
		// return res.status(200).json({
			// success:true,
			// message: `Zamówienie nr ${req.params.orderId} usunięte poprawnie`
		// });
	// }
	// else{
		// return res.status(400).json({
			// success:false,
			// message: `Nie znaleziono zamówienia`
		// })
	// }
// })
// 
// app.delete('/position/:positionId/delete', async (req,res) =>{
	// console.log(req.params.orderId);
	// let response = await db.deletePosition(req.params.positionId);
		// if (response){
			// return res.status(200).json({
				// success:true,
				// message: `Pozycja ${req.params.positionId} usunięta poprawnie`
			// });
		// }
		// else{
			// return res.status(400).json({
				// success:false,
				// message: `Nie znaleziono Pozycji`
			// })
		// }
	// })
// 
// 
app.use('/orders', ordersRoutes);
app.use('/position', positionsRoutes);
app.use('/', mainRoutes);
app.use('/user', userRoutes);

app.listen(process.env.PORT, () => 
			console.log(`Server działa na porcie ${process.env.PORT}`));



