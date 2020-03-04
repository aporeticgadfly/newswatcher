"use strict";
var express = require('express');
var bcrypt = require('bcryptjs'); //pwd hash comparisons
var jwt = require('jwt-simple'); //token auth
var joi = require('joi'); //data validation
var authHelper = require('./authHelper');

var router = express.Router();

//security token created as user logs in that can be passed to client, can be utilized on subsequent calls

router.post('/', function postSession(req, res, next) {
  //pwd must be 7-15 chars, at least 1 numeric digit, 1 special char
  var schema = {
    email: joi.string().email().min(7).max(50).required(),
    password: joi.string().regex(/^(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{7,15}$/).required()
  };

  joi.validate(req.body, schema, function(err) {
    if(err){
      return next(new Error('Invalid field: password 7 to 15 (one number, one special character)'));
    }

    req.db.collection.findOne({ type: 'USER_TYPE', email: req.body.email},
      function(err, user) {
        if(err) {
          return next(err);
        }
        if(!user) {
          return next(new Error('User was not found.'));
        }

        bcrypt.compare(req.body.password, user.passwordHash, function comparePassword(err, match) {
          if(match) {
            try {
              var token = jwt.encode({ authorized: true, sessionIP: req.ip, sessionUA: req.headers['user-agent'], userId: user._id.toHexString(), displayName: user.displayName}, process.env.JWT_SECRET);
              res.status(201).json({displayName: user.displayName, userId: user._id.toHexString(), token: token, msg: 'Authorized'});
            }
            catch(err){
              return next(err);
            }
          }
          else {
            return next(new Error('Wrong password'));
          }
        });
      });
  });
});

//delete token on log out
router.delete('/:id', authHelper.checkAuth, function (req, res, next) {
  //check passed in id is same as in auth token
  if(req.params.id != req.auth.userId){
    return next(new Error('Invalid request for logout'));
  }

  res.status(200).json({msg: 'Logged out'});
});

module.exports = router;
