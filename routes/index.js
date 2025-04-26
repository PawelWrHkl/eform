const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const db = require("../db/db_helper.js");

router.get("/", requireLogin, async (req, res)  => {
    user = await db.getUserData(req.session.user.pin);
    return res.render("base.njk", { user:user });
    
});

module.exports = router;