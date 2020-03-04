// stories first seen by user, no need to be logged in

"use strict";
var express = require('express');

var router = express.Router();

router.get('/', function(req, res, next) {
  req.db.collection.findOne(
    { _id: process.env.GLOBAL_STORIES_ID},
    { homeNewsStories: 1},
    function (err, doc) {
      if(err) {
        return next(err);
      }

      res.status(200).json(doc.homeNewsStories);
    });
});

module.exports = router;
