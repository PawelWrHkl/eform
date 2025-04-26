const express = require("express");
const path = require("path");
const nunjucks = require("nunjucks");
const dotenv = require("dotenv").config();
const session = require("express-session");
const app = express();
const ordersRoutes = require('./routes/orders');
const positionsRoutes = require('./routes/positions');
const userRoutes = require('./routes/users');
const mainRoutes = require('./routes/index');
const bodyParser = require("body-parser");

app.use(session({
	secret: process.env.SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	cookie: {
		secure: false,           
		httpOnly: true,
		sameSite: "lax",
		maxAge: 1000 * 60 * 60,
		// domain: "eform.tkproject.eu" 
	}
}));


app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static(path.join(__dirname, "public")));

nunjucks.configure("templates", {
	autoescape: true,
	express: app,
	noCache: true,
});


app.use('/orders', ordersRoutes);
app.use('/position', positionsRoutes);
app.use('/user', userRoutes);
app.use('/', mainRoutes);



const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
	console.log(`Server działa na porcie ${PORT}`)
);
