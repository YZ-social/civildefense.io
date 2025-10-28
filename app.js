const express = require('express');
const path = require('path');
const logger = require('morgan');
const addIndexRoutes = require('./routes/index');
const app = express();
const expressWs = require('express-ws')(app);

process.title = 'yz.social';
app.use(logger('dev'));

// No need:
//var cookieParser = require('cookie-parser');
//app.use(express.json());
//app.use(express.urlencoded({ extended: false }));
//app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'public')));
addIndexRoutes(app);

module.exports = app;


