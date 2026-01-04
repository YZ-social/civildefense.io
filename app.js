import process from 'node:process';
import path from 'node:path';
import express from 'express';
import expressWs from 'express-ws';
import logger from 'morgan';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const app = express();

// We must allow expressWs to bach the internals of app before
// pulling in routes/index.js. Thus a dynamic import is used so that
// we can control when routes/index.js is processed.
expressWs(app);
const Yz = await import('./routes/index.js');

process.title = 'yz.social';
app.use(logger('dev'));

// No need:
//var cookieParser = require('cookie-parser');
//app.use(express.json());
//app.use(express.urlencoded({ extended: false }));
//app.use(cookieParser());

app.use('/images', express.static(path.join(__dirname, 'public/images'), {maxAge: '1d', immutable: true}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', Yz.router);
