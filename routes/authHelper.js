 //injects middleware to validate request header User token
 "use strict";
 var jwt = require('jwt-simple');

 //check for token, verify signature and tampering
 module.exports.checkAuth = function(req, res, next) {
   if(req.headers['x-auth']) {
     try {
       req.auth = jwt.decode(req.headers[x-auth], process.env.JWT_SECRET);
       if (req.auth && req.auth.authorized && req.auth.userId) {
         return next();
       }
       else {
         return next(new Error('User is not logged in.'));
       }
     }
     catch (err) {
       return next(err);
     }
   }
   else {
     return next(new Error('User is not logged in.'));
   }
 };
