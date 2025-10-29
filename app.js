const path = require('path');
const express = require('express');
const expressWs = require('express-ws');
const logger = require('morgan');
const app = express();

expressWs(app);
const Yz = require('./routes/index'); // Must be after expressWs() call.

process.title = 'yz.social';
app.use(logger('dev'));

// No need:
//var cookieParser = require('cookie-parser');
//app.use(express.json());
//app.use(express.urlencoded({ extended: false }));
//app.use(cookieParser());

app.use('/images', express.static(path.join(__dirname, 'public/images'), {maxAge: '1d', immutable: true}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', Yz);

module.exports = app;


