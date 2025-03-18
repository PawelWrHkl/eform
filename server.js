const express = require("express");
const path = require("path");
const nunjucks = require("nunjucks");
const dotenv = require("dotenv");
const mysql = require("mysql");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const app = express();

const userTest = { pin: "0000", password: "1234" };


// scizki do template
app.use(express.static(path.join(__dirname, "public")));
const templatePath = path.join(__dirname, "templates");

// korzystanie z json
app.use(express.urlencoded({extended: 'false'}))
app.use(express.json());

// konfiguracja nunjucks (silnik do widoków)
nunjucks.configure("templates", {
	autoescape: true,
	express: app,
	noCache: true,
});

app.use(session({
	secret:'No bardzo sekretne',
	resave:false,
	saveUninitialized:true,
	cookie: {secure:false, maxAge:9999999999999 }
}));

function requireLogin(req,res, next){
	if (!req.session.user){
		return res.redirect('/login');
	}
	next();
}

// endpointy
app.get("/", requireLogin, (req, res) => {
	res.render("base.njk", { title: "" });
});

app.get("/new_order", requireLogin, (req, res) => {
	res.render("form.njk");
});

app.get("/orders", requireLogin, (req, res) => {
	res.render("orders.njk");
});

app.get("/login", (req, res) => {
	res.render("login.njk");
});

app.post("/auth/login", (req, res, next) => {
	const {pin,password} = req.body;
	console.log(req.body.pin);
	console.log(req.body.password);
	if (req.body.pin == userTest.pin && req.body.password == userTest.password){
		req.session.user = userTest;
		res.redirect("/");

	} 
	else{
		res.render('login.njk',
			{message:"Dane nieprawidłowe."})
	}

	
});

app.post("/logout", (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect("/");
        res.redirect("/login");
    });
});

app.listen(8000, () => console.log("Server działa na porcie 8000"));
