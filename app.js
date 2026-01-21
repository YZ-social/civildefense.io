#!/usr/bin/env node
import process from 'node:process';
import {cpus, availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import expressWs from 'express-ws';
import logger from 'morgan';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const logicalCores = availableParallelism();

const argv = yargs(hideBin(process.argv))
      .usage(`Start an http server for Alert and with nPortals nodes to connect through. Model description "${cpus()[0].model}", ${logicalCores} logical cores.`)
      .option('nPortals', {
	alias: 'p',
	type: 'number',
	default: Math.max(logicalCores, 2),
	description: "The number of steady nodes that handle initial connections."
      })
      .option('baseURL', {
	type: 'string',
	default: 'http://localhost:3000/kdht',
	description: "The base URL of the portal server through which to bootstrap."
      })
      .option('externalBaseURL', {
	type: 'string',
	default: '',
	description: "The base URL of the some other portal server to which we should connect ours, if any."
      })
      .option('fixedSpacing', {
	type: 'number',
	default: 2,
	description: "Minimum seconds to add between each portal."
      })
      .options('variableSpacing', {
	type: 'number',
	default: 5,
	description: "Additional variable seconds (+/- variableSpacing/2) to add to fixedSpacing between each portal."
      })
      .option('verbose', {
	alias: 'v',
	type: 'boolean',
	description: "Run with verbose logging."
      })
      .parse();

if (cluster.isPrimary) { // Parent process with portal webserver through which clienta can bootstrap
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const port = parseInt((new URL(argv.baseURL)).port || '80');
  process.title = 'yz.social';
  const app = express();
  app.use(logger(':date[iso] :status :method :url :res[content-length] - :response-time ms'));

  // We must allow expressWs to bach the internals of app before
  // pulling in routes/index.js. Thus a dynamic import is used so that
  // we can control when routes/index.js is processed.
  expressWs(app);
  const Yz = await import('./routes/index.js');

  for (let i = 0; i < argv.nPortals; i++) cluster.fork();
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
  const {baseURL, externalBaseURL, fixedSpacing, variableSpacing, verbose} = argv;
  portalNode.setup({baseURL, externalBaseURL, fixedSpacing, variableSpacing, verbose});
}
