"use strict";
var bcrypt = require('bcryptjs');
var https = require("https");
var async = require('async');
var assert = require('assert');
var ObjectId = require('mongodb').ObjectID;
var MongoClient = require('mongodb').MongoClient;

var globalNewsDoc;
const NEWYORKTIMES_CATEGORIES = ["home", "world", "national", "business", "technology"];

var db = {};
MongoClient.connect(process.env.MONGODB_CONNECT_URL, { useNewUrlParser: true }, function(err, client) {
  assert.equal(null, err);
  db.client = client;
  db.collection = client.db('newswatcherdb').collection('NewsWatcher');
  console.log("fork is connected to MongoDB server");
});

//communications w parent process
process.on('message', function (m) {
  if(m.msg) {
    if(m.msg == 'REFRESH_STORIES') {
      setImmediate(function (doc) {
        refreshStoriesMSG(doc, null);
      }, m.doc);
    }
  }
  else {
    console.log('Message from master:', m);
  }
});

//refresh of user stories based on selected filters

function refreshStoriesMSG(doc, callback) {
  if(!globalNewsDoc) {
    db.collection.findOne({ _id: process.env.GLOBAL_STORIES_ID}, function(err, gDoc){
      if(err) {
        console.log('FORK_ERROR: readDocument() read err:' + err);
        if(callback) {
          return callback(err);
        }
        else {
          return;
        }
      }
      else {
        globalNewsDoc = gDoc;
        refreshStories(doc, callback);
      }
    });
  }
  else {
    refreshStories(doc, callback);
  }
}

function refreshStories(doc, callback) {
  for(var filterIdx = 0; filterIdx < doc.newsFilters.length; filterIdx++) {
    doc.newsFilters[filterIdx].newsStories = [];
    for(var i = 0; i < globalNewsDoc.newsStories.length; i++) {
      globalNewsDoc.newsStories[i].keep = false;
    }

    //if keywords present, filter using them
    if("keyWords" in doc.newsFilters[filterIdx] && doc.newsFilters[filterIdx].keyWords[0] != ""){
      var storiesMatched = 0;
      for(var i=0; i < doc.newsFilters[filterIdx].keyWords.length; i++) {
        for(var j=0; j < globalNewsDoc.newsStories.length; j++) {
          if(globalNewsDoc.newsStories[j].keep == false) {
            var s1 = globalNewsDoc.newsStories[j].title.toLowerCase();
            var s2 = globalNewsDoc.newsStories[j].contentSnippet.toLowerCase();
            var keyword = doc.newsFilters[filterIdx].keyWords[i].toLowerCase();
            if(s1.indexOf(keyword) >= 0 || s2.indexOf(keyword) >= 0) {
              globalNewsDoc.newsStories[j].keep = true;
              storiesMatched++;
            }
          }
          if(storiesMatched == process.env.MAX_FILTER_STORIES){
            break;
          }
        }
        if(storiesMatched == process.env.MAX_FILTER_STORIES) {
          break;
        }
      }

      for(var k = 0; k < globalNewsDoc.newsStories.length; k++) {
        if(globalNewsDoc.newsStories[k].keep == true) {
          doc.newsFilters[filterIdx].newsStories.push(globalNewsDoc.newsStories[k]);
        }
      }
    }
  }

  //for test runs
  if(doc.newsFilters.length == 1 && doc.newsFIlters[0].keyWords.length == 1 && doc.newsFilters[0].keyWords[0] == "testingKeyword") {
    for(var i = 0; i < 5; i++) {
      doc.newsFilters[0].newsStories.push(globalNewsDoc.newsStories[0]);
      doc.newsFilters[0].newsStories[0].title = "testingKeyword title" + i;
    }
  }

  //actual replacement
  db.collection.findOneAndUpdate(
    { _id: ObjectId(doc.id) },
    { $set: {
        "newsFilters": doc.newsFilters}
    },
    function(err, result) {
      if(err) {
        console.log('FORK_ERROR Replace of newsStories failed:', err);
      }
      else if(result.ok != 1) {
        console.log('FORK_ERROR Replace of newsStories failed:', result);
      }
      else {
        if(doc.newsFilters.length > 0) {
          console.log({ msg: 'MASTERNEWS_UPDATE first filter news length = '' + doc.newsFilters[0].newsStories.length });
        }
        else {
          console.log({ msg: 'MASTERNEWS_UPDATE no newsFilters'});
        }
      }
      if(callback) {
        return callback(err);
      }
    });
}

//timer for populating master news list from New York Times API
var count = 0;
newsPullBackgroundTimer = setInterval(function () {

  var date = new Date();
  console.log("app_FORK: datetime tick: " + date.toUTCString());
  async.timesSeries(NEWYORKTIMES_CATEGORIES.length, function (n, next) {
    setTimeout(function () {
      console.log('Get news stories from NYT. Pass #', n);
      try {
        https.get({
          host: 'api.nytimes.com',
          path: '/svc/topstories/v2/' + NEWYORKTIMES_CATEGORIES[n] + '.json',
          headers: { 'api-key': process.env.NEWYORKTIMES_API_KEY }
        }, function(res) {
            var body = '';
            res.on('data', function(d) {
              body += d;
            });
            res.on('end', function () {
              next(null, body);
            });
        }).on('error', function (err) {
            //handle errors w request itself
            console.log({msg: 'FORK_ERROR', Error: err.message });
            return;
        });
      }

      catch (err) {
        count++;
        if(count == 3) {
          console.log('app_FORK.js: shutting down timer:' + err);
          clearInterval(newsPullBackgroundTimer);
          clearInterval(staleStoryDeleteBackgroundTimer);
          process.disconnect();
        }
        else {
          console.log('app_FORK.js error. err:' + err);
        }
      }
    }, 500);
  }, function (err, results) {
      if(err) {
        console.log('failure');
      }
      else {
        console.log('success');
        //replacement of stories in single master doc
        db.collection.findOne(
          { _id: process.env.GLOBAL_STORIES_ID },
          function(err, gDoc) {
            if(err) {
              console.log({ msg: 'FORK_ERROR', Error: 'Error with the global news doc read request:' + JSON.stringify(err.body, null, 4)});
            }
            else {
              gDoc.newsStories = [];
              gDoc.homeNewsStories = [];
              var allNews = [];
              for(var i = 0; i < results.length; i++) {
                try {
                  var news = JSON.parse(results[i]);
                }
                catch (e) {
                  console.error(e);
                  return;
                }
                for(var j = 0; j < news.results.length; j++) {
                  var xferNewsStory = {
                    link: news.results[j].url,
                    title: news.results[j].title,
                    contentSnippet: news.results[j].abstract,
                    source: news.results[j].section,
                    date: new Date(news.results[j].updated_date).getTime()
                  };
                  //only take stories with images
                  if(news.results[j].multimedia.length > 0) {
                    xferNewsStory.imageUrl = news.results[j].multimedia[0].url;
                    allNews.push(xferNewsStory);
                    //populate home page stories
                    if(i == 0) {
                      gDoc.homeNewsStories.push(xferNewsStory);
                    }
                  }
                }
              }

              async.eachSeries(allNews, function(story, innercallback) {
                bcrypt.hash(story.link, 10, function getHash(err, hash) {
                  if(err){
                    innercallback(err);
                  }

                  //only add if not there already. Can be shared btwn NYT categories
                  story.storyID = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                  if(gDoc.newsStories.findIndex(function (o) {
                    if(o.storyID == story.storyID || o.title == story.title) {
                      return true;
                    }
                    else {
                      return false;
                    }
                  }) == -1) {
                    gDoc.newsStories.push(story);
                  }
                  innercallback();
                });
              }, function (err) {
                  if(err) {
                    console.log('failure on story id creation');
                  }
                  else {
                    console.log('story id creation success');
                    globalNewsDoc = gDoc;
                    setImmediate(function() {
                      refreshAllUserStories();
                    });
                  }
              });
            }
          });
      }
  });
}, 240 * 60 * 1000);

function refreshAllUserStories() {
  db.collection.findOneAndUpdate(
    { _id: globalNewsDoc._id },
    { $set: {newsStories: globalNewsDoc.newsStories, homeNewsStories: globalNewsDoc.homeNewsStories } },
    function (err, result) {
      if(err) {
        console.log('FORK_ERROR Replace of global newsStories failed:', err);
      }
      else if(result.ok != 1) {
        console.log('Replace of global newsStories failed:', result);
      }
      else {
        //for each user, news match their filters
        var cursor = db.collection.find({ type: 'USER_TYPE'});
        var keepProcessing = true;
        async.doWhilst(
          function (callback) {
            cursor.next(function (err, doc) {
              if(doc) {
                refreshStories(doc, function (err) {
                  callback(null);
                });
              }
              else {
                keepProcessing = false;
                callback(null);
              }
            });
          },
          function() { return keepProcessing;},
          function (err) {
            console.log('Timer: Refreshed and matched. err:', err);
          }
        );
      }
    });
}

//deletes shared stories after certain amount of time

staleStoryDeleteBackgroundTimer = setInterval(function () {
  db.collection.find({type: 'SHAREDSTORY_TYPE' }).toArray(
    function(err, docs) {
      if(err) {
        console.log('Fork could not get shared stories. err:', err);
        return;
      }

      async.eachSeries(docs, function (story, innercallback) {
        //use date of when story was shared
        var d1 = story.comments[0].dateTime;
        var d2 = Date.now();
        var diff = Math.floor((d2 - d1) / 3600000);

        if(diff > 72) {
          db.collection.findOneAndDelete(
            { type: 'SHAREDSTORY_TYPE', _id: story._id},
            function(err, result) {
              innercallback(err);
            });
        }
        else {
          innercallback();
        }
      }, function (err) {
          if(err) {
            console.log('stale story deletion failure');
          }
          else{
            console.log('stale story deletion success');
          }
      });
    });
}, 24 * 60 * 60 * 1000);
