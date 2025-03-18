const express = require("express");
const path = require("path");
const nunjucks = require("nunjucks");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const templatePath = path.join(__dirname, "templates");

nunjucks.configure("templates", {
	autoescape: true,
	express: app,
	noCache: true,
});

app.get("/", (req, res) => {
	res.render("base.njk", { title: "" });
});

app.get("/new_order", (req, res) => {
	res.render("form.njk");
});

app.get("/orders", (req, res) => {
	res.render("orders.njk");
});

app.get("/login", (req, res) => {
	res.render("login.njk");
});

app.post("/logout", (req, res, next) => {
	res.redirect("/login");
});

app.listen(8000, () => console.log("Server działa na porcie 8000"));
