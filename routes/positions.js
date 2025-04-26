const express = require('express');
const router = express.Router();
const { requireLogin } = require('../middleware/loginMixture');
const db = require("../db/db_helper.js");
const fs = require('fs');
const path = require('path');

router.post('/save', requireLogin, async (req, res) => {
    try {
      const formData = req.body;
      console.log(formData);
      const result = await db.insertNewForm(formData);
      res.json({ status: "success", message: "Dane zapisane poprawnie" });
    } catch (err) {
      return res.status(400).json({ error: "Niepoprawne dane" });
    }
  });

router.delete('/:positionId/delete', requireLogin, async (req,res) =>{
  // console.log(req.params.orderId);
  let response = await db.deletePosition(req.params.positionId);
      if (response){
          return res.status(200).json({
              success:true,
              message: `Pozycja ${req.params.positionId} usunięta poprawnie`
          });
      }
      else{
          return res.status(400).json({
              success:false,
              message: `Nie znaleziono Pozycji`
          })
      }
  })
  
  router.get('/:positionId/', requireLogin, async (req,res) =>{
    // console.log(req.params.orderId);
    let result = await db.getPosition(req.params.positionId);
    console.log(result)
        if (result){
          return res.render('edit_form.njk',{position:result})}
        else{
            return res.status(400).json({
                success:false,
            })
        }
    })
    

  
  router.post('/check-images', requireLogin, async (req, res) => {
    try {
      const { options, groupNumber, folderName } = req.body;
  
      if (!Array.isArray(options) || !groupNumber || !folderName) {
        return res.status(400).json({ error: 'Brak wymaganych danych' });
      }
      
      const result = {};
  
      for (const opt of options) {
        const value = opt.VALUE;
        const basePath = path.join(__dirname, '..', 'public', 'data', groupNumber.toString(), folderName);

        const jpgPath = path.join(basePath, `${value}.jpg`);
        const pngPath = path.join(basePath, `${value}.png`);
  
        if (fs.existsSync(jpgPath)) {
          result[value] = 'jpg';
        } else if (fs.existsSync(pngPath)) {
          result[value] = 'png';
        } else {
          result[value] = null;
        }
      }
  
      return res.json(result);
    } catch (err) {
      console.error("Błąd sprawdzania obrazów:", err);
      return res.status(500).json({ error: "Błąd serwera" });
    }
  });

module.exports = router;