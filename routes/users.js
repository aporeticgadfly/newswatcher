var express = require('express');
var bcrypt = require('bcryptjs');
var async = require('async');
var joi = require('joi');
var authHelper = require('./authHelper');
var objectId = require('mongodb').ObjectId;

var router = express.Router();

//POST: create user with passed in JSON of http body
router.post('/', function postUser (req, res, next) {
  //pwd must be 7-15 chars, 1 number, 1 special char
  var schema = {
    displayName: joi.string().alphanum().min(3).max(50).required(),
    email: joi.string().email().min(7).max(50).required(),
    password: joi.string().regex(/^(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{7-15}$/).required()
  };

  joi.validate(req.body, schema, function (err, value) {
    if(err) {
      return next(new Error('Invalid field: display name 3 to 50 alphanumeric, valid email, password 7 to 15 (one number, one special character)'));
    }

    req.db.collection.findOne({type: 'USER_TYPE', email: req.body.email}, function(err, doc) {
      if(err) {
        return next(err);
      }

      if(doc) {
        return next(new Error('Email account already registered'));
      }

      var xferUser = {
        type: 'USER_TYPE',
        displayName: req.body.displayName,
        email: req.body.email,
        passwordHash: null,
        date: Date.now(),
        completed: false,
        settings: {
          requireWIFI: true,
          enableAlerts: false
        },
        newsFilter: [{
          name: 'Technology Companies',
          keyWords: ['Apple', 'Microsoft', 'IBM', 'Amazon', 'Google', 'Intel'],
          enableAlert: false,
          alertFrequency: 0,
          enableAutoDelete: false,
          deleteTime: 0,
          timeOfLastScan: 0,
          newsStories: []
        }],
        savedStories: []
      };

      bcrypt.hash(req.body.password, 10, function getHash(err, hash) {
        if (err) {
          return next(err);
        }

        xferUser.passwordHash = hash;
        req.db.NewsWatcher.insertOne(xferUser, function createUser(err, result) {
          if(err) {
            return next(err);
          }
          req.node2.send({msg: 'REFRESH_STORIES', doc: result.ops[0] });
          res.status(201).json(result.ops[0]);
        });
      });
    });
  });
});

//DELETE: delete a user

router.delete('/:id', authHelper.checkAuth, function(req, res, next) {
  if(req.params.id != req.auth.userId) {
    return next(new Error('Invalid request for account deletion'));
  }

  req.db.collection.findOneAndDelete(
    { type: 'USER_TYPE', _id: ObjectId(req.auth.userId) },
    function (err, result) {
      if(err) {
        console.log("POSSIBLE USER DELETION CONTENTION? err:", err);
        return next(err);
      }
      else if(result.ok != 1) {
        console.log("POSSIBLE USER DELETION ERROR? result:", result);
        return next(new Error('Account deletion failure'));
      }

      res.status(200).json({msg: "User Deleted"});
    });
});

//GET: return JSON of specified user

router.get('/:id', authHelper.checkAuth, function(req, res, next) {
  if (req.params.id != req.auth.userId) {
    return next(new Error('Invalid request for account fetch'));
  }

  req.db.collection.findOne({type: 'USER_TYPE', _id: ObjectId(req.auth.userId)},

  function(err, doc) {
    if(err) return next(err);

    var xferProfile = {
      email:doc.email,
      displayName: doc.displayName,
      date: doc.date,
      settings: doc.settings,
      newsFilters: doc.newsFilters,
      savedStories: doc.savedStories
    };
    //modifying header files so cache doesnt occur, returned is most up to date
    res.header("Cache-control", "no-cache, no-store, must-revalidate");
    res.header("Pragma", "no-cache");
    res.header("Expires", 0);
    res.status(200).json(xferProfile);
  });
});

//PUT: replace user with passed in JSON Of HTTP body

router.put('/:id', authHelper.checkAuth, function (req, res, next) {
  if(req.params.id != req.auth.userId) {
    return next(new Error('Invalid request for update'));
  }

  if(req.body.newsFilters.length > process.env.MAX_FILTERS) {
    return next(new Error('Too many news filters'));
  }

  //clear out whitespace
  for(var i = 0; i < req.body.newsFilters.length; i++) {
    if("keyWords" in req.body.newsFilters[i] && req.body.newsFilters[i].keyWords[0] != "") {
      for(var j = 0; j < req.body.newsFilters[i].keyWords.length; j++) {
        req.body.newsFilters[i].keyWords[j] = req.body.newsFilters[i].keyWords[j].trim();
      }
    }
  }

  //validate filters
  var schema = {
    name: joi.string().min(1).max(30).regex(/^[-_ a-zA-Z0-9]+$/).required(),
    keyWords: joi.array().max(10).items(joi.string().max(20)).required(),
    enableAlert: joi.boolean(),
    alertFrequency: joi.number().min(0),
    enableAutoDelete: joi.boolean(),
    deleteTime: joi.date(),
    timeOfLastScan: joi.date(),
    newsStories: joi.array(),
    keywordsStr: joi.string().min(1).max(100)
  };

  async.eachSeries(req.body.newsFilters, function(filter, innercallback) {
    joi.validate(filter, schema, function(err) {
      innercallback(err);
    });
  }, function(err) {
      if(err) {
        return next(err);
      }
      else {
        req.db.collection.findOneAndUpdate(
          { type: 'USER_TYPE', _id: ObjectId(req.auth.userId)},
          { $set: {
            settings: {
              requireWIFI: req.body.requireWIFI,
              enableAlerts: req.body.enableAlerts
            },
            newsFilters: req.body.newsFilters
            }
          },
          {returnOriginal: false},
          function(err, result){
            if(err) {
              console.log("+++POSSIBLE USER PUT CONTENTION ERROR?+++ err:", err);
              return next(err);
            }
            else if(result.ok != 1) {
              console.log("+++POSSIBLE CONTENTION ERROR?+++ result: ", result);
              return next(new Error('User PUT failure'));
            }

            req.node2.send({msg: 'REFRESH_STORIES', doc: result.value});
            res.status(200).json(result.value);

        });
      }
  });
});

//POST: save a story for user, content is in JSON body
//need to verify story not already inserted, and that limit isnt exceeded, stories have an id associated w them

router.post('/:id/savedstories', authHelper.checkAuth, function (req, res, next) {
  if(req.params.id != req.auth.userId) {
    return next(new Error('Invalid request for saving story'));
  }

    var schema = {
      contentSnippet: joi.string().max(200).required(),
      date: joi.date().required(),
      hours: joi.string().max(20),
      imageUrl: joi.string().max(300).required(),
      keep: joi.boolean().required(),
      link: joi.string().max(300).required(),
      source: joi.string().max(50).required(),
      storyID: joi.string().max(100).required(),
      title: joi.string().max(200).required()
    };

    joi.validate(req.body, schema, function(err) {
      if(err) {
        return next(err);
      }

      req.db.collection.findOneAndUpdate({ type: 'USER_TYPE', _id: ObjectId(req.auth.userId)},
      {$addToSet: {savedStories: req.body }},
      {returnOriginal: true},
      function(err, result) {
        if(result && result.value == null) {
          return next(new Error('Over the save limit, or story already saved'));
        }
        else if(err) {
          console.log("+++POSSIBLE CONTENTION ERROR?+++ err:", err);
          return next(err);
        }
        else if(result.ok != 1) {
          console.log("+++POSSIBLE CONTENTION ERROR?+++ result:", result);
          return next(new Error('Story save failure'));
        }

        res.status(200).json(result.value);
      });
    });
});

//DELETE: delete a previously saved story for user

router.delete('/:id/savedstories/:sid', authHelper.checkAuth, function(req, res, next) {
  if(req.params.id != req.auth.userId) {
    return next(new Error('Invalid request for deletion of saved story'));
  }

  req.db.collection.findOneAndUpdate(
    { type: 'USER_TYPE', _id: ObjectId(req.auth.userId)},
    {$pull: {savedStories: { storyID: req.params.sid } } },
    {returnOriginal: true },
    function (err, result) {
      if(err) {
        console.log("+++POSSIBLE CONTENTION ERROR?+++ err:", err);
        return next(err);
      }
      else if(result.ok != 1) {
        console.log("+++POSSIBLE CONTENTION ERROR?+++ result:", result);
        return next(new Error('Story delete failure'));
      }

      res.status(200).json(result.value);
    });
});

module.exports = router;
