#!/usr/bin/env node
import process from 'node:process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebContact } from '@yz-social/kdht';

const argv = yargs(hideBin(process.argv))
      .usage(`Announce to the DHT at baseURL that you are available to connect through at portalURL.`)
      .option('portalURL', {
	type: 'string',
	description: "The PUBLIC url that you are announcing."
      })
      .option('baseURL', {
	type: 'string',
	default: 'http://localhost:3000/kdht',
	description: "The base URL of the portal server through which to bootstrap."
      })
      .parse();

const contact = await WebContact.create();
await contact.connect(argv.baseURL);
await contact.publish({eventName: 'sys:portals', payload: argv.portalURL});
await contact.disconnect();

