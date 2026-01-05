import process from 'node:process';
import cluster from 'node:cluster';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import expressWs from 'express-ws';
import logger from 'morgan';
import { fileURLToPath } from 'url';

const port = 3000;

if (cluster.isPrimary) { // Parent process with portal webserver through which clienta can bootstrap
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const nPortals = 5;
  process.title = 'yz.social';
  const app = express();
  app.use(logger('dev'));

  // We must allow expressWs to bach the internals of app before
  // pulling in routes/index.js. Thus a dynamic import is used so that
  // we can control when routes/index.js is processed.
  expressWs(app);
  const Yz = await import('./routes/index.js');

  for (let i = 0; i < nPortals; i++) cluster.fork();
  app.use(express.json());
  const portalServer = await import('@yz-social/kdht/router');

  app.use('/images', express.static(path.join(__dirname, 'public/images'), {maxAge: '1d', immutable: true}));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/', Yz.router);
  app.use('/kdht', portalServer.router);

  app.listen(port);
  console.log('Listening on', port);

} else {
  const portalNode = await import('@yz-social/kdht/portal');
  //const {fixedSpacing, variableSpacing, verbose} = argv;
  const fixedSpacing = 3, variableSpacing = 5, verbose = false;
  const baseURL = `http://localhost:${port}/kdht`;
  portalNode.setup({baseURL, fixedSpacing, variableSpacing, verbose});
}
