require('dotenv').config();
var express = require('express');
var path = require('path');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cp = require('child_process');
var responseTime = require('response-time');
var assert = require('assert');
var helmet = require('helmet');
var RateLimit = require('express-rate-limit');
var csp = require('helmet-csp');

if(process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

var users = require('./routes/users');
var session = require('./routes/session');
var sharedNews = require('./routes/sharedNews');
var homeNews = require('./routes/homeNews');

var app = express();
app.enable('trust proxy');

//apply limits to all requests
var limiter = new RateLimit({
  windowMs: 15 * 60 * 1000, //15 mins
  max: 100, //limit each IP to 100 requests per windowMs
  delayMs: 0 //disable delaying, full speed until max limit
});
app.use(limiter);

app.use(helmet()); //use defaults to start
app.use(csp({
  //specifying directives for content sources
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'ajax.googleapis.com', 'maxcdn.bootstrapcdn.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'maxcdn.bootstrapcdn.com'],
    fontSrc: ["'self'", 'maxcdn.bootstrapcdn.com'],
    imgSrc: ['*']
  }
}));

//adds x-response-time header to responses to measure response time
app.use(responseTime());

//logs all HTTP reqs, dev option gives specific styling
app.use(logger('dev'));

//sets up response object in routes to contain body property with object of what is parsed from JSON body request payload
app.use(bodyParser.json({limit: '100kb'}));

//main HTML page to be returned
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

//serving of static content such as HTML for React, images, CSS, JS
app.use(express.static(path.join(__dirname, 'build')));

//separate Node process for compute intensive code
var node2 = cp.fork('./worker/app_FORK.js');

node2.on('exit', function(code) {   //restarts if experiencing runtime errors
  node2 = undefined;
  node2 = cp.fork('./worker/app_FORK.js');
});

var db = {};
var MongoClient = require('mongodb').MongoClient;

//
MongoClient.connect(process.env.MONGODB_CONNECT_URL, {useNewUrlParser: true}, function (err, client) {
  assert.equal(null, err);
  db.client = client;
  db.collection = client.db('newswatcherdb').collection('NewsWatcher');
});

//shared objects injected into request processing chain as properties of req object, middleware
app.use(function (req, res, next) {
  req.db = db;
  req.node2 = node2;
  next();
});

//REST API routes
app.use('/api/users', users);
app.use('/api/sessions', session);
app.use('/api/sharednews', sharedNews);
app.use('/api/homenews', homeNews);

//error handling route for urls
app.use(function (req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

//code error handler, first is development error handler, second is production error handler for users, first adds a stack trace
if (app.get('env') === 'development') {
  app.use(function (err, req, res, next) {
    res.status(err.status || 500).json({ message: err.toString(), error: err});
    console.log(err);
  });
}

app.use(function (err, req, res, next) {
  res.status(err.status || 500).json({message: err.toString(), error: {}});
  console.log(err);
});

app.set('port', process.env.PORT || 3000);

var server = app.listen(app.get('port'), function () {
  console.log('Express server listening on port:' + server.address().port);
});

//export server for testing framework to use
server.db = db;
server.node2 = node2;
module.exports = server;
