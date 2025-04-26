const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const authService = require('../services/authService')

const db = require("../db/db_helper.js");

router.get("/login", (req, res) => {
	res.render("login.njk");
});

router.post("/auth/login", async (req, res, next) => {
    try {
        const { pin, password } = req.body;
        const isValid = await authService.checkPassword(pin, password);
        console.log(isValid);
        if (isValid) {
            req.session.user = { pin, password };
            
            return res.redirect("/");
        } else {
            return res.render("login.njk", { message: "Dane nieprawidłowe" });
        }
    } catch (err) {
        return next(err);
    }
});

router.post("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.redirect("/");
        res.redirect("/user/login");
    });
});

module.exports = router;